mod commands;
mod error;
mod excel_parser;
mod models;
mod parser;

use commands::{get_app_data_dir, read_file_bytes, scan_root_directory, scan_root_directory_meta, scan_author_media_files, parse_excel_file};

/// WebView2 启动参数：启用 HEVC 硬件解码
///
/// Chromium 内核（含 WebView2 / Edge）默认不启用 HEVC 解码，即使系统
/// 已安装 Microsoft.HEVCVideoExtensions + GPU 支持 HEVC 硬解也不行。
/// 通过 `WebviewWindowBuilder::additional_browser_args()` 显式传入 feature flag
/// 启用硬件解码路径：
///   --enable-features=PlatformHEVCDecoderSupport
///
/// `additional_browser_args` 会**覆盖** wry 默认的
/// `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`，
/// 因此必须自己加上这些 disable-features，否则会启用 PDF/OOUI 等组件。
///
/// 参考：
///   - https://github.com/StaZhu/enable-chromium-hevc-hardware-decoding
///   - https://learn.microsoft.com/microsoft-edge/webview2/concepts/webview-features-flags
#[cfg(target_os = "windows")]
const WEBVIEW2_ADDITIONAL_ARGS: &str = concat!(
    "--enable-features=PlatformHEVCDecoderSupport",
    " --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection",
    " --ignore-gpu-blocklist"
);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .setup(|app| {
            // 主窗口配置原本在 tauri.conf.json 的 app.windows 中定义
            // 改用 WebviewWindowBuilder 创建以便注入 additional_browser_args
            #[cfg(target_os = "windows")]
            {
                let _window = tauri::webview::WebviewWindowBuilder::new(
                    app,
                    "main",
                    tauri::WebviewUrl::default(),
                )
                .title("抖音索引")
                .inner_size(1400.0, 900.0)
                .min_inner_size(1000.0, 650.0)
                .additional_browser_args(WEBVIEW2_ADDITIONAL_ARGS)
                .build()?;
            }

            // 非 Windows 平台无需 additional_browser_args
            #[cfg(not(target_os = "windows"))]
            {
                let _window = tauri::webview::WebviewWindowBuilder::new(
                    app,
                    "main",
                    tauri::WebviewUrl::default(),
                )
                .title("抖音索引")
                .inner_size(1400.0, 900.0)
                .min_inner_size(1000.0, 650.0)
                .build()?;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_root_directory,
            scan_root_directory_meta,
            scan_author_media_files,
            get_app_data_dir,
            read_file_bytes,
            parse_excel_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
