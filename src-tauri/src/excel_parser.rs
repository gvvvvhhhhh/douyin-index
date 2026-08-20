use calamine::{open_workbook, Data, Range, Reader};
use serde_json::{Map, Value};
use std::path::Path;

use crate::error::{AppError, AppResult};

/// 中文表头 → 字段名映射（与前端 HEADER_MAP 保持一致）
fn normalize_header(h: &str) -> String {
    let s = h.trim();
    match s {
        "作品类型" => "workType".into(),
        "UID" => "uid".into(),
        "SEC_UID" | "SEC-UID" => "secUid".into(),
        "作品ID" => "workId".into(),
        "作品描述" => "description".into(),
        "作品话题" => "topics".into(),
        "视频时长" => "duration".into(),
        "视频高度" => "height".into(),
        "视频宽度" => "width".into(),
        "发布时间" => "publishTime".into(),
        "采集时间" | "采集日期" => "collectTime".into(),
        "视频URI" => "videoUri".into(),
        "账号昵称" => "authorName".into(),
        "账号签名" => "authorSignature".into(),
        "作品链接" => "downloadUrl".into(),
        "音乐作者" => "musicAuthor".into(),
        "音乐标题" => "musicTitle".into(),
        "静态封面" => "coverStatic".into(),
        "动态封面" => "coverDynamic".into(),
        "隐藏标签" => "hiddenTags".into(),
        "点赞数量" => "likeCount".into(),
        "评论数量" => "commentCount".into(),
        "收藏数量" => "favoriteCount".into(),
        "分享数量" => "shareCount".into(),
        "播放数量" => "playCount".into(),
        "额外信息" => "extraInfo".into(),
        _ => s.replace(" ", ""),
    }
}

/// 将单元格值转为字符串
fn cell_to_str(d: &Data) -> String {
    match d {
        Data::String(s) => s.trim().to_string(),
        Data::Int(n) => n.to_string(),
        Data::Float(f) => {
            // 整数不显示小数点
            if *f == f.trunc() {
                format!("{}", *f as i64)
            } else {
                format!("{}", f)
            }
        }
        Data::DateTime(dt) => {
            // ExcelDateTime 的 Display 实现给出合理的日期字符串
            format!("{}", dt)
        }
        Data::Bool(b) => b.to_string(),
        Data::DurationIso(s) => s.to_string(),
        Data::DateTimeIso(s) => s.to_string(),
        Data::Error(e) => format!("{:?}", e),
        Data::Empty => String::new(),
    }
}

/// 将单元格值转为整数（支持中文数字格式：万/亿/w/W）
fn cell_to_int(d: &Data) -> Option<i64> {
    match d {
        Data::Int(n) => Some(*n as i64),
        Data::Float(f) => Some(*f as i64),
        Data::String(s) => {
            let cleaned = s.trim().replace(",", "");
            if cleaned.is_empty() {
                return None;
            }
            // 直接数字
            if let Ok(n) = cleaned.parse::<f64>() {
                return Some(n as i64);
            }
            // 万/w/W
            let lower = cleaned.to_lowercase();
            if lower.ends_with("万") || lower.ends_with("w") {
                let num_str = lower
                    .trim_end_matches("万")
                    .trim_end_matches("w")
                    .trim();
                if let Ok(n) = num_str.parse::<f64>() {
                    return Some((n * 10000.0) as i64);
                }
            }
            // 亿
            if cleaned.ends_with("亿") {
                let num_str = cleaned.trim_end_matches("亿").trim();
                if let Ok(n) = num_str.parse::<f64>() {
                    return Some((n * 100000000.0) as i64);
                }
            }
            None
        }
        _ => None,
    }
}

/// 数值型字段集合
const INT_FIELDS: &[&str] = &[
    "likeCount",
    "commentCount",
    "favoriteCount",
    "shareCount",
    "playCount",
    "height",
    "width",
];

/// 从 Range 中提取行数据
fn process_range(range: &Range<Data>) -> Vec<Value> {
    let mut rows: Vec<Value> = Vec::new();
    let mut iter = range.rows().peekable();
    if iter.peek().is_none() {
        return rows;
    }

    // 第一行是表头
    let header_row = iter.next().unwrap();
    let headers: Vec<String> = header_row.iter().map(|c| normalize_header(&cell_to_str(c))).collect();

    for row in iter {
        let mut obj = Map::new();
        for (i, cell) in row.iter().enumerate() {
            if i >= headers.len() {
                break;
            }
            let key = &headers[i];
            if key.is_empty() {
                continue;
            }

            // 空单元格跳过
            if matches!(cell, Data::Empty) {
                continue;
            }

            let value = if INT_FIELDS.contains(&key.as_str()) {
                match cell_to_int(cell) {
                    Some(n) => Value::Number(n.into()),
                    None => Value::Null,
                }
            } else {
                Value::String(cell_to_str(cell))
            };

            obj.insert(key.clone(), value);
        }
        if !obj.is_empty() {
            rows.push(Value::Object(obj));
        }
    }

    rows
}

/// 在 Rust 中解析 Excel 文件，返回结构化 JSON 数据
/// 替代前端 readFileBytes + SheetJS 解析，速度提升 10-50x
pub fn parse_excel_file(file_path: &str) -> AppResult<(Vec<Value>, Vec<String>)> {
    let path = Path::new(file_path);
    if !path.exists() {
        return Err(AppError::Path(format!("Excel文件不存在: {}", file_path)));
    }

    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match extension.as_str() {
        "xlsx" | "xlsm" => {
            let mut workbook = open_workbook::<calamine::Xlsx<_>, _>(path)
                .map_err(|e| AppError::Excel(format!("打开xlsx失败: {}", e)))?;
            let sheet_names = workbook.sheet_names().to_vec();
            let mut rows: Vec<Value> = Vec::new();
            for name in &sheet_names {
                if let Ok(range) = workbook.worksheet_range(name) {
                    rows.extend(process_range(&range));
                }
            }
            Ok((rows, sheet_names))
        }
        "xls" => {
            let mut workbook = open_workbook::<calamine::Xls<_>, _>(path)
                .map_err(|e| AppError::Excel(format!("打开xls失败: {}", e)))?;
            let sheet_names = workbook.sheet_names().to_vec();
            let mut rows: Vec<Value> = Vec::new();
            for name in &sheet_names {
                if let Ok(range) = workbook.worksheet_range(name) {
                    rows.extend(process_range(&range));
                }
            }
            Ok((rows, sheet_names))
        }
        "ods" => {
            let mut workbook = open_workbook::<calamine::Ods<_>, _>(path)
                .map_err(|e| AppError::Excel(format!("打开ods失败: {}", e)))?;
            let sheet_names = workbook.sheet_names().to_vec();
            let mut rows: Vec<Value> = Vec::new();
            for name in &sheet_names {
                if let Ok(range) = workbook.worksheet_range(name) {
                    rows.extend(process_range(&range));
                }
            }
            Ok((rows, sheet_names))
        }
        _ => Err(AppError::Excel(format!(
            "不支持的文件格式: {}",
            extension
        ))),
    }
}
