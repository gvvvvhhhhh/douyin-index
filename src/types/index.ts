export type MediaKind = "video" | "image" | "livephoto";

export interface ParsedFileMeta {
  publish_time_raw: string;
  publish_time_iso: string;
  category: string;
  author_name: string;
  title: string;
  full_title: string;
  tags: string[];
  sequence: number | null;
  extension: string;
  media_kind: MediaKind;
  file_path: string;
  file_name: string;
  file_size: number;
}

export interface AuthorFolderInfo {
  folder_name: string;
  uid: string;
  author_name: string;
  source_type: string;
  folder_path: string;
}

export interface ScanResult {
  root_path: string;
  authors: AuthorFolderInfo[];
  excel_files: string[];
  media_files: ParsedFileMeta[];
  total_files: number;
  skipped_files: number;
  skipped_samples: string[];
}

// ============ 数据库实体 ============

export interface AuthorRow {
  id?: number;
  uid: string;
  name: string;
  signature?: string | null;
  folder_path?: string | null;
  work_count?: number;
  created_at?: number;
}

export interface WorkRow {
  id: number;
  work_id?: string | null;
  author_id?: number | null;
  title?: string | null;
  description?: string | null;
  work_type?: string | null;
  topics?: string | null;
  publish_time?: number | null;
  duration?: number | null;
  width?: number | null;
  height?: number | null;
  like_count?: number | null;
  comment_count?: number | null;
  favorite_count?: number | null;
  share_count?: number | null;
  play_count?: number | null;
  cover_static?: string | null;
  cover_dynamic?: string | null;
  video_uri?: string | null;
  download_url?: string | null;
  music_author?: string | null;
  music_title?: string | null;
  hidden_tags?: string | null;
  extra_info?: string | null;
  file_count?: number | null;
  created_at?: number | null;
  source_type?: string | null;
  original_author?: string | null;
  collect_time?: number | null;
  sec_uid?: string | null;
}

export interface FileRow {
  id: number;
  work_id: number;
  absolute_path: string;
  filename: string;
  extension?: string | null;
  media_type?: string | null;
  seq?: number | null;
  size_bytes?: number | null;
  mtime?: number | null;
  created_at?: number | null;
}

export interface ThumbnailRow {
  id: number;
  file_id: number;
  thumb_path: string;
  width?: number | null;
  height?: number | null;
  generated_at?: number | null;
}

// 前端展示用的聚合作品类型
export interface WorkWithFiles {
  work: WorkRow;
  author?: AuthorRow;
  files: FileRow[];
  tags: string[];
  hiddenTags: string[];
}

// Excel 元数据行 (字段命名根据实际Excel调整)
export interface ExcelMetaRow {
  workType?: string;
  uid?: string;
  secUid?: string;
  workId?: string;
  description?: string;
  topics?: string;
  duration?: string;
  height?: number;
  width?: number;
  publishTime?: string;
  collectTime?: string;
  videoUri?: string;
  authorName?: string;
  authorSignature?: string;
  downloadUrl?: string;
  musicAuthor?: string;
  musicTitle?: string;
  coverStatic?: string;
  coverDynamic?: string;
  hiddenTags?: string;
  likeCount?: number;
  commentCount?: number;
  favoriteCount?: number;
  shareCount?: number;
  playCount?: number;
  extraInfo?: string;
  [key: string]: unknown;
}

/**
 * excel_rows 表的数据库记录（缓存 Excel 元数据，用于单独导入 xlsx
 * 不创建作品，仅为后续作品导入时提供匹配元数据）
 */
export interface ExcelRowRecord {
  id?: number;
  batch_id: number;          // 时间戳，同次导入的行共用
  source_uid: string;        // 作者 UID
  source_type: string;       // 发布作品/收藏作品/喜欢作品
  source_filename: string;
  source_path: string;       // 去重键
  work_id: string | null;
  description: string | null;
  topics: string | null;
  publish_time: string | null;
  collect_time: string | null;
  duration: string | null;
  height: number | null;
  width: number | null;
  like_count: number | null;
  comment_count: number | null;
  favorite_count: number | null;
  share_count: number | null;
  play_count: number | null;
  cover_static: string | null;
  cover_dynamic: string | null;
  video_uri: string | null;
  download_url: string | null;
  music_author: string | null;
  music_title: string | null;
  hidden_tags: string | null;
  extra_info: string | null;
  sec_uid: string | null;
  author_name: string | null;
  author_signature: string | null;
  work_type: string | null;
  imported_at: number;
}

/** excel_rows 批次聚合行（GROUP BY batch_id 后的展示用） */
export interface ExcelBatchRow {
  batch_id: number;
  source_uid: string;
  source_type: string;
  source_filename: string;
  source_path: string;
  row_count: number;
  imported_at: number;
}
