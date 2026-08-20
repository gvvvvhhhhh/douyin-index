use crate::error::{AppError, AppResult};
use crate::excel_parser;
use crate::models::{AuthorFolderInfo, ParsedFileMeta, ScanResult};
use crate::parser::{is_media_file, parse_author_folder, parse_media_filename};
use std::path::Path;
use walkdir::WalkDir;

/// 读取文件内容（返回字节）
#[tauri::command]
pub fn read_file_bytes(file_path: String) -> AppResult<Vec<u8>> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err(AppError::Path(format!("文件不存在: {}", file_path)));
    }
    let bytes = std::fs::read(path)?;
    Ok(bytes)
}

/// 扫描根目录，识别作者文件夹、Excel文件和媒体文件
#[tauri::command]
pub fn scan_root_directory(root_path: String) -> AppResult<ScanResult> {
    let root = Path::new(&root_path);
    if !root.exists() {
        return Err(AppError::Path(format!("路径不存在: {}", root_path)));
    }
    if !root.is_dir() {
        return Err(AppError::Path(format!("不是目录: {}", root_path)));
    }

    let mut authors: Vec<AuthorFolderInfo> = Vec::new();
    let mut excel_files: Vec<String> = Vec::new();
    let mut media_files: Vec<ParsedFileMeta> = Vec::new();
    let mut total_files: usize = 0;
    let mut skipped_files: usize = 0;
    let mut skipped_samples: Vec<String> = Vec::new();

    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let entry_path = entry.path();
        let name = match entry_path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };

        if entry_path.is_file() {
            if let Some(ext) = entry_path.extension().and_then(|s| s.to_str()) {
                if ext.eq_ignore_ascii_case("xlsx") || ext.eq_ignore_ascii_case("xls") {
                    excel_files.push(entry_path.to_string_lossy().to_string());
                }
            }
            continue;
        }

        if name.eq_ignore_ascii_case("Data") {
            for excel_entry in std::fs::read_dir(&entry_path)? {
                let excel_entry = excel_entry?;
                let ep = excel_entry.path();
                if let Some(ext) = ep.extension().and_then(|s| s.to_str()) {
                    if ext.eq_ignore_ascii_case("xlsx") || ext.eq_ignore_ascii_case("xls") {
                        excel_files.push(ep.to_string_lossy().to_string());
                    }
                }
            }
            continue;
        }

        if let Some(info) = parse_author_folder(&name, &entry_path.to_string_lossy()) {
            // 用文件夹作者名作为解析提示，支持文件名中含 "-" 的作者名（如 "-矢量鱼-"）
            let author_hint: Option<&str> = Some(info.author_name.as_str());
            for file_entry in WalkDir::new(&entry_path)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_file())
            {
                let file_path = file_entry.path();
                let file_name = match file_path.file_name().and_then(|s| s.to_str()) {
                    Some(n) => n.to_string(),
                    None => continue,
                };

                if !is_media_file(&file_name) {
                    continue;
                }

                total_files += 1;
                match parse_media_filename(file_path, author_hint) {
                    Ok(meta) => media_files.push(meta),
                    Err(e) => {
                        skipped_files += 1;
                        if skipped_samples.len() < 20 {
                            skipped_samples.push(format!("{} ({})", file_name, e));
                        }
                    }
                }
            }
            authors.push(info);
        }
    }

    Ok(ScanResult {
        root_path: root_path.clone(),
        authors,
        excel_files,
        media_files,
        total_files,
        skipped_files,
        skipped_samples,
    })
}

/// 分阶段扫描 Phase 1：只扫描顶层目录（作者文件夹 + Excel 文件），不扫描媒体文件
/// 用于超大规模目录（3TB+），避免一次性加载百万文件到内存导致 OOM/IPC 阻塞
#[tauri::command]
pub fn scan_root_directory_meta(root_path: String) -> AppResult<ScanResult> {
    let root = Path::new(&root_path);
    if !root.exists() {
        return Err(AppError::Path(format!("路径不存在: {}", root_path)));
    }
    if !root.is_dir() {
        return Err(AppError::Path(format!("不是目录: {}", root_path)));
    }

    let mut authors: Vec<AuthorFolderInfo> = Vec::new();
    let mut excel_files: Vec<String> = Vec::new();

    // 根目录本身就是作者文件夹（如用户直接选择 UIDxxx_作者名_类型）：
    // 把它作为唯一作者处理，同时收集文件夹内的 Excel 元数据文件
    let root_name = root.file_name().and_then(|s| s.to_str()).unwrap_or("");
    if let Some(info) = parse_author_folder(root_name, &root.to_string_lossy()) {
        for entry in std::fs::read_dir(root)? {
            let entry = entry?;
            let ep = entry.path();
            if let Some(ext) = ep.extension().and_then(|s| s.to_str()) {
                if ep.is_file() && (ext.eq_ignore_ascii_case("xlsx") || ext.eq_ignore_ascii_case("xls")) {
                    excel_files.push(ep.to_string_lossy().to_string());
                }
            }
        }
        authors.push(info);
        return Ok(ScanResult {
            root_path,
            authors,
            excel_files,
            media_files: Vec::new(),
            total_files: 0,
            skipped_files: 0,
            skipped_samples: Vec::new(),
        });
    }

    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let entry_path = entry.path();
        let name = match entry_path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };

        if entry_path.is_file() {
            if let Some(ext) = entry_path.extension().and_then(|s| s.to_str()) {
                if ext.eq_ignore_ascii_case("xlsx") || ext.eq_ignore_ascii_case("xls") {
                    excel_files.push(entry_path.to_string_lossy().to_string());
                }
            }
            continue;
        }

        if name.eq_ignore_ascii_case("Data") {
            for excel_entry in std::fs::read_dir(&entry_path)? {
                let excel_entry = excel_entry?;
                let ep = excel_entry.path();
                if let Some(ext) = ep.extension().and_then(|s| s.to_str()) {
                    if ext.eq_ignore_ascii_case("xlsx") || ext.eq_ignore_ascii_case("xls") {
                        excel_files.push(ep.to_string_lossy().to_string());
                    }
                }
            }
            continue;
        }

        if let Some(info) = parse_author_folder(&name, &entry_path.to_string_lossy()) {
            authors.push(info);
        }
    }

    // media_files 为空，前端会逐个作者文件夹调用 scan_author_media_files
    Ok(ScanResult {
        root_path,
        authors,
        excel_files,
        media_files: Vec::new(),
        total_files: 0,
        skipped_files: 0,
        skipped_samples: Vec::new(),
    })
}

/// 分阶段扫描 Phase 2：扫描单个作者文件夹的媒体文件
/// 前端按作者逐个调用，处理完即释放内存，避免百万文件同时驻留内存
#[tauri::command]
pub fn scan_author_media_files(folder_path: String) -> AppResult<Vec<ParsedFileMeta>> {
    let folder = Path::new(&folder_path);
    if !folder.exists() || !folder.is_dir() {
        return Err(AppError::Path(format!("路径无效: {}", folder_path)));
    }

    let mut media_files: Vec<ParsedFileMeta> = Vec::new();

    // 从文件夹名（UIDxxx_作者名_类型）提取作者名提示，支持文件名中含 "-" 的作者名
    let author_hint: Option<String> = folder
        .file_name()
        .and_then(|s| s.to_str())
        .and_then(|name| parse_author_folder(name, "").map(|info| info.author_name));
    let hint: Option<&str> = author_hint.as_deref();

    for file_entry in WalkDir::new(folder)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        let file_path = file_entry.path();
        let file_name = match file_path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };

        if !is_media_file(&file_name) {
            continue;
        }

        if let Ok(meta) = parse_media_filename(file_path, hint) {
            media_files.push(meta);
        }
    }

    Ok(media_files)
}

/// 获取应用数据目录路径
#[tauri::command]
pub fn get_app_data_dir(app: tauri::AppHandle) -> AppResult<String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Path(format!("无法获取数据目录: {}", e)))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.to_string_lossy().to_string())
}

/// 在 Rust 中解析 Excel 文件（使用 calamine 库）
/// 替代前端 readFileBytes + SheetJS，速度提升 10-50x
#[derive(serde::Serialize)]
pub struct ExcelParseResult {
    pub rows: Vec<serde_json::Value>,
    pub sheet_names: Vec<String>,
}

#[tauri::command]
pub fn parse_excel_file(file_path: String) -> AppResult<ExcelParseResult> {
    let (rows, sheet_names) = excel_parser::parse_excel_file(&file_path)?;
    Ok(ExcelParseResult { rows, sheet_names })
}
