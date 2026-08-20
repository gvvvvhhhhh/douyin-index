use serde::{Deserialize, Serialize};

/// 媒体文件类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    /// 视频
    Video,
    /// 图片
    Image,
    /// 实况图片
    LivePhoto,
}

impl MediaKind {
    pub fn from_extension(ext: &str) -> Self {
        match ext.to_lowercase().as_str() {
            "mp4" | "mov" | "avi" | "mkv" | "flv" | "webm" | "m4v" => MediaKind::Video,
            "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp" => MediaKind::Image,
            _ => MediaKind::Image,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            MediaKind::Video => "video",
            MediaKind::Image => "image",
            MediaKind::LivePhoto => "livephoto",
        }
    }
}

/// 从文件名解析出的元数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedFileMeta {
    /// 发布时间字符串 (YYYY-MM-DD HH.MM.SS)
    pub publish_time_raw: String,
    /// ISO 8601 格式时间
    pub publish_time_iso: String,
    /// 作品类型标识 (视频/图集/实况)
    pub category: String,
    /// 作者名
    pub author_name: String,
    /// 标题
    pub title: String,
    /// 完整标题（包含标签，如 '#黑皮' 或 '#无处安放的小jio #纯情女高'）
    pub full_title: String,
    /// 标签列表
    pub tags: Vec<String>,
    /// 序号 (多文件作品)
    pub sequence: Option<u32>,
    /// 文件扩展名 (不含.)
    pub extension: String,
    /// 媒体类型
    pub media_kind: MediaKind,
    /// 完整文件路径
    pub file_path: String,
    /// 文件名
    pub file_name: String,
    /// 文件大小(字节)
    pub file_size: u64,
}

/// 作者文件夹信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthorFolderInfo {
    /// 完整文件夹名 (UIDxxx_作者名_作品类型)
    pub folder_name: String,
    /// UID
    pub uid: String,
    /// 作者名
    pub author_name: String,
    /// 作品类型 (发布作品/收藏作品)
    pub source_type: String,
    /// 文件夹路径
    pub folder_path: String,
}

/// 扫描结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    /// 根目录
    pub root_path: String,
    /// 发现的作者文件夹
    pub authors: Vec<AuthorFolderInfo>,
    /// Data目录下的Excel文件列表
    pub excel_files: Vec<String>,
    /// 解析出的所有媒体文件
    pub media_files: Vec<ParsedFileMeta>,
    /// 扫描统计
    pub total_files: usize,
    pub skipped_files: usize,
    pub skipped_samples: Vec<String>,
}

/// 数据库初始化结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbInitResult {
    pub db_path: String,
    pub schema_version: String,
    pub fresh_init: bool,
}
