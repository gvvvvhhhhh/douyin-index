use crate::error::{AppError, AppResult};
use crate::models::{AuthorFolderInfo, MediaKind, ParsedFileMeta};
use chrono::NaiveDateTime;
use regex::Regex;
use std::path::Path;
use std::sync::OnceLock;

/// 文件名前缀正则：YYYY-MM-DD HH.MM.SS-类型-（固定部分，作者名之前）
static FILENAME_PREFIX_RE: OnceLock<Regex> = OnceLock::new();
/// 文件名尾部正则：标题#标签_序号.扩展名（作者名之后的部分）
static FILENAME_TAIL_RE: OnceLock<Regex> = OnceLock::new();
/// 作者文件夹名正则：UIDxxx_作者名_作品类型
static AUTHOR_DIR_RE: OnceLock<Regex> = OnceLock::new();

fn filename_prefix_regex() -> &'static Regex {
    FILENAME_PREFIX_RE.get_or_init(|| {
        // 1: datetime  2: 类型（类型不含 -，如 视频/图集/实况）
        Regex::new(r"^(\d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2})-([^-]+)-").expect("filename prefix regex")
    })
}

fn filename_tail_regex() -> &'static Regex {
    FILENAME_TAIL_RE.get_or_init(|| {
        // 1: 标题+标签(可为空，.*? 允许空标题如 "TTe-.mp4")  2: 序号(可选)  3: 扩展名
        Regex::new(r"^(.*?)(?:_(\d+))?\.([A-Za-z0-9]+)$").expect("filename tail regex")
    })
}

fn author_dir_regex() -> &'static Regex {
    AUTHOR_DIR_RE.get_or_init(|| {
        Regex::new(r"^(UID\d+)_(.+)_(.+)$").expect("author dir regex")
    })
}

/// 解析作者文件夹名
pub fn parse_author_folder(folder_name: &str, folder_path: &str) -> Option<AuthorFolderInfo> {
    let caps = author_dir_regex().captures(folder_name)?;
    Some(AuthorFolderInfo {
        folder_name: folder_name.to_string(),
        uid: caps[1].to_string(),
        author_name: caps[2].to_string(),
        source_type: caps[3].to_string(),
        folder_path: folder_path.to_string(),
    })
}

/// 从"标题+标签"部分拆分出标题和标签
/// 输入形如 "我的作品#旅行 #风景" 或 "我的作品"
fn split_title_tags(title_with_tags: &str) -> (String, Vec<String>) {
    // 找到第一个 # 的位置作为标签开始
    if let Some(idx) = title_with_tags.find('#') {
        let title = title_with_tags[..idx].trim_end().to_string();
        let tags_part = &title_with_tags[idx..];
        let tags: Vec<String> = tags_part
            .split_whitespace()
            .filter(|s| s.starts_with('#'))
            .map(|s| s.trim_start_matches('#').to_string())
            .filter(|s| !s.is_empty())
            .collect();
        (title, tags)
    } else {
        (title_with_tags.trim().to_string(), Vec::new())
    }
}

/// 拆分 "作者名-标题部分"。返回 (作者名, 标题部分)。
/// 作者名本身可包含 "-"（如 "-矢量鱼-"），仅凭文件名无法消除歧义：
/// 1. 优先用作者文件夹名（author_hint）精确锚定：rest 以 "{hint}-" 开头 → 精确拆分；
///    （收藏/喜欢文件夹内文件名是原始作者，提示不命中时自动走兜底）
/// 2. 兜底：第一个不在首位的 "-" 作为分隔符——作者名不含 "-" 时与旧行为完全一致，
///    作者名以 "-" 开头时也能解析成功（不再整文件跳过）
fn split_author_and_tail<'a>(rest: &'a str, author_hint: Option<&str>) -> Option<(String, &'a str)> {
    if let Some(hint) = author_hint {
        if !hint.is_empty() {
            if let Some(tail) = rest.strip_prefix(&format!("{}-", hint)) {
                return Some((hint.to_string(), tail));
            }
        }
    }
    // 从第 2 个字符起找 "-"（保证作者名至少 1 个字符）；
    // 按字符边界切片（作者名可能是多字节 UTF-8），"-" 是单字节 ASCII，切分点安全
    let first_char_len = rest.chars().next()?.len_utf8();
    let idx = rest[first_char_len..].find('-')? + first_char_len;
    Some((rest[..idx].to_string(), &rest[idx + 1..]))
}

/// 解析单个媒体文件名
/// author_hint：所在作者文件夹的作者名（UIDxxx_作者名_类型 解析结果），用于精确拆分含 "-" 的作者名
pub fn parse_media_filename(
    file_path: &Path,
    author_hint: Option<&str>,
) -> AppResult<ParsedFileMeta> {
    let file_name = file_path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::Path(format!("无法获取文件名: {}", file_path.display())))?
        .to_string();

    let parse_err = || AppError::Parse(format!("文件名不符合规范: {}", file_name));

    // 1. 固定前缀：datetime-类型-
    let caps = filename_prefix_regex()
        .captures(&file_name)
        .ok_or_else(parse_err)?;
    let publish_time_raw = caps[1].to_string();
    let category = caps[2].to_string();
    // 前缀之后的剩余部分：作者名-标题#标签_序号.扩展名
    let rest = &file_name[caps.get(0).unwrap().end()..];

    // 2. 拆分作者名（支持含 "-" 的作者名）
    let (author_name, tail) = split_author_and_tail(rest, author_hint).ok_or_else(parse_err)?;

    // 3. 尾部：标题+标签(可空)_序号.扩展名
    let tail_caps = filename_tail_regex().captures(tail).ok_or_else(parse_err)?;
    let title_with_tags = tail_caps[1].to_string();
    let sequence = tail_caps.get(2).map(|m| m.as_str().parse::<u32>().unwrap_or(1));
    let extension = tail_caps[3].to_lowercase();

    // 转换时间格式: YYYY-MM-DD HH.MM.SS -> ISO
    let dt = NaiveDateTime::parse_from_str(&publish_time_raw, "%Y-%m-%d %H.%M.%S")?;
    let publish_time_iso = dt.format("%Y-%m-%dT%H:%M:%S").to_string();

    let (title, tags) = split_title_tags(&title_with_tags);

    let media_kind = if category.contains("视频") {
        MediaKind::Video
    } else if category.contains("实况") {
        MediaKind::LivePhoto
    } else {
        MediaKind::from_extension(&extension)
    };

    let file_size = std::fs::metadata(file_path).map(|m| m.len()).unwrap_or(0);

    Ok(ParsedFileMeta {
        publish_time_raw,
        publish_time_iso,
        category,
        author_name,
        title,
        full_title: title_with_tags,
        tags,
        sequence,
        extension,
        media_kind,
        file_path: file_path.to_string_lossy().to_string(),
        file_name,
        file_size,
    })
}

/// 判断文件是否为支持的媒体文件
pub fn is_media_file(file_name: &str) -> bool {
    let ext = file_name.rsplit('.').next().map(|s| s.to_lowercase());
    matches!(
        ext.as_deref(),
        Some("mp4" | "mov" | "avi" | "mkv" | "flv" | "webm" | "m4v"
            | "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_author_folder() {
        let info = parse_author_folder("UID12345_张三_发布作品", "/path").unwrap();
        assert_eq!(info.uid, "UID12345");
        assert_eq!(info.author_name, "张三");
        assert_eq!(info.source_type, "发布作品");
    }

    #[test]
    fn test_parse_author_folder_with_hyphen_name() {
        // 作者名含 "-" 的文件夹
        let info = parse_author_folder("UID12345_-矢量鱼-_发布作品", "/path").unwrap();
        assert_eq!(info.uid, "UID12345");
        assert_eq!(info.author_name, "-矢量鱼-");
        assert_eq!(info.source_type, "发布作品");
    }

    #[test]
    fn test_parse_filename_with_tags_and_seq() {
        let p = Path::new("/root/2024-01-15 14.30.25-视频-张三-我的作品#旅行 #风景_1.mp4");
        let meta = parse_media_filename(p, None).unwrap();
        assert_eq!(meta.publish_time_raw, "2024-01-15 14.30.25");
        assert_eq!(meta.category, "视频");
        assert_eq!(meta.author_name, "张三");
        assert_eq!(meta.title, "我的作品");
        assert_eq!(meta.tags, vec!["旅行", "风景"]);
        assert_eq!(meta.sequence, Some(1));
        assert_eq!(meta.extension, "mp4");
        assert_eq!(meta.media_kind, MediaKind::Video);
    }

    #[test]
    fn test_parse_filename_no_tags_no_seq() {
        let p = Path::new("/root/2024-01-15 14.30.25-图集-李四-美好的一天.jpg");
        let meta = parse_media_filename(p, None).unwrap();
        assert_eq!(meta.title, "美好的一天");
        assert!(meta.tags.is_empty());
        assert_eq!(meta.sequence, None);
        assert_eq!(meta.media_kind, MediaKind::Image);
    }

    #[test]
    fn test_author_name_with_hyphens_with_hint() {
        // 作者名 "-矢量鱼-"：用作者文件夹名提示精确拆分（旧行为会整文件跳过）
        let p = Path::new("/root/2024-05-01 10.00.00-视频--矢量鱼--我的标题#标签_2.mp4");
        let meta = parse_media_filename(p, Some("-矢量鱼-")).unwrap();
        assert_eq!(meta.author_name, "-矢量鱼-");
        assert_eq!(meta.title, "我的标题");
        assert_eq!(meta.tags, vec!["标签"]);
        assert_eq!(meta.sequence, Some(2));
    }

    #[test]
    fn test_author_name_with_hyphen_hint_exact() {
        // 作者名中间含 "-"：提示精确命中
        let p = Path::new("/root/2024-05-01 10.00.00-视频-AB-CD-标题.mp4");
        let meta = parse_media_filename(p, Some("AB-CD")).unwrap();
        assert_eq!(meta.author_name, "AB-CD");
        assert_eq!(meta.title, "标题");
    }

    #[test]
    fn test_hint_mismatch_falls_back_to_first_hyphen() {
        // 收藏文件夹：文件名是原始作者，与文件夹作者提示不一致 → 兜底拆分
        let p = Path::new("/root/2024-05-01 10.00.00-视频-千寻-标题.mp4");
        let meta = parse_media_filename(p, Some("枫临")).unwrap();
        assert_eq!(meta.author_name, "千寻");
        assert_eq!(meta.title, "标题");
    }

    #[test]
    fn test_author_with_leading_hyphen_no_hint() {
        // 无提示且作者以 "-" 开头：兜底按首个有效 "-" 拆分，不再整文件跳过
        let p = Path::new("/root/2024-05-01 10.00.00-视频--矢量鱼--标题.mp4");
        let meta = parse_media_filename(p, None).unwrap();
        assert_eq!(meta.author_name, "-矢量鱼");
        assert_eq!(meta.title, "-标题");
    }

    #[test]
    fn test_split_title_tags() {
        let (t, tags) = split_title_tags("标题#标签1 #标签2");
        assert_eq!(t, "标题");
        assert_eq!(tags, vec!["标签1", "标签2"]);
    }

    #[test]
    fn test_empty_title() {
        // 真实数据中存在的空标题文件
        let p = Path::new("/root/2023-08-11 17.39.13-视频-TTe-.mp4");
        let meta = parse_media_filename(p, None).unwrap();
        assert_eq!(meta.title, "");
        assert_eq!(meta.author_name, "TTe");
        assert_eq!(meta.category, "视频");
        assert_eq!(meta.sequence, None);
    }

    #[test]
    fn test_title_with_dashes() {
        // 标题包含连字符
        let p = Path::new("/root/2023-10-23 18.43.04-视频-TTe-—-忍-—.mp4");
        let meta = parse_media_filename(p, None).unwrap();
        assert_eq!(meta.title, "—-忍-—");
        assert_eq!(meta.author_name, "TTe");
    }

    #[test]
    fn test_title_with_dots() {
        // 标题包含点号
        let p = Path::new("/root/2024-03-15 17.39.28-视频-TTe-.₊̣̇.ෆ˚ෆ.₊̣̇.mp4");
        let meta = parse_media_filename(p, None).unwrap();
        assert_eq!(meta.title, ".₊̣̇.ෆ˚ෆ.₊̣̇");
        assert_eq!(meta.extension, "mp4");
    }

    #[test]
    fn test_live_photo_mixed_media() {
        // 实况作品混合 jpeg 和 mp4，序号 10
        let p = Path::new("/root/2026-03-10 18.38.55-实况-TTe-妳要走了雨也不会停。_10.jpeg");
        let meta = parse_media_filename(p, None).unwrap();
        assert_eq!(meta.category, "实况");
        assert_eq!(meta.title, "妳要走了雨也不会停。");
        assert_eq!(meta.sequence, Some(10));
        assert_eq!(meta.media_kind, MediaKind::LivePhoto);
    }

    #[test]
    fn test_tags_with_space_before() {
        // 标签前有空格: "最近绘 #procreate"
        let p = Path::new("/root/2025-07-30 23.10.04-图集-TTe-最近绘 #procreate_1.jpeg");
        let meta = parse_media_filename(p, None).unwrap();
        assert_eq!(meta.title, "最近绘");
        assert_eq!(meta.tags, vec!["procreate"]);
    }

    #[test]
    fn test_long_title_with_tags() {
        // 长标题+多标签
        let p = Path::new("/root/2025-10-24 18.19.54-图集-TTe-ᗜ - ᗜ。#stocking #致歉一切 #试妆_1.jpeg");
        let meta = parse_media_filename(p, None).unwrap();
        assert_eq!(meta.title, "ᗜ - ᗜ。");
        assert_eq!(meta.tags, vec!["stocking", "致歉一切", "试妆"]);
        assert_eq!(meta.sequence, Some(1));
    }

    #[test]
    fn test_video_no_sequence() {
        // 视频无序号
        let p = Path::new("/root/2025-08-12 17.20.15-视频-TTe-我虽然记性不太好 但我记得我给过你脸.mp4");
        let meta = parse_media_filename(p, None).unwrap();
        assert_eq!(meta.title, "我虽然记性不太好 但我记得我给过你脸");
        assert_eq!(meta.sequence, None);
    }
}
