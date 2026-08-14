// 文件附件展示：文档 / 图片 占位物
// 文件字段结构不稳定，做防御性解析；无内容 URL 时显示占位物

function fmtSize(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

function FileCard({ f }: { f: any }) {
  const name: string = f?.file_name || f?.name || '文件';
  const size = fmtSize(f?.file_size ?? f?.size);
  const isImage = !!(f?.is_image || f?.model_kind === 'VISION' || /^image\//.test(f?.content_type ?? ''));
  const url: string | undefined = f?.url || f?.file_url || f?.preview_url;

  // 图片：有 url 渲染缩略图，否则占位
  if (isImage) {
    return (
      <div className="file-card file-image">
        {url ? (
          <img src={url} alt={name} loading="lazy" className="file-thumb" />
        ) : (
          <div className="file-thumb file-thumb-ph">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <rect x="3" y="3" width="18" height="18" rx="3" />
              <circle cx="8.5" cy="8.5" r="1.6" />
              <path d="M21 15l-5-5-9 9" />
            </svg>
          </div>
        )}
        <span className="file-name">{name}</span>
      </div>
    );
  }

  // 文档占位
  return (
    <div className="file-card file-doc">
      <span className="file-icon">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
      </span>
      <span className="file-meta">
        <span className="file-name">{name}</span>
        {size && <span className="file-size">{size}</span>}
      </span>
    </div>
  );
}

export default function FileAttachments({ files }: { files: unknown[] }) {
  if (!files || files.length === 0) return null;
  return (
    <div className="file-attachments">
      {files.map((f, i) => (
        <FileCard key={(f as any)?.id ?? i} f={f} />
      ))}
    </div>
  );
}