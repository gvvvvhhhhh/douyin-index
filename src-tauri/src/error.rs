use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("IO错误: {0}")]
    Io(#[from] std::io::Error),

    #[error("正则错误: {0}")]
    Regex(#[from] regex::Error),

    #[error("时间解析错误: {0}")]
    Chrono(#[from] chrono::ParseError),

    #[error("路径错误: {0}")]
    Path(String),

    #[error("解析错误: {0}")]
    Parse(String),

    #[error("数据库错误: {0}")]
    Database(String),

    #[error("Excel解析错误: {0}")]
    Excel(String),

    #[error("其他错误: {0}")]
    Other(#[from] anyhow::Error),
}

pub type AppResult<T> = Result<T, AppError>;

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}
