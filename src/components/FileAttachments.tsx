// 文件附件展示：图片内联缩略 + 文档占位
// 对齐 DeepSeek 真实文件结构（is_image + signed_path）。
// 图片 src 用 loadFileImage 解析：浏览器直接给 URL（dev 走 /file-svc 代理）；
// 原生 WebView 走 OkHttp 伪装头拉取转 data URL，绕过 WAF 跨域拦截。

import { useEffect, useState } from 'react';
import type { ChatFile } from '../core/api/types';
import { loadFileImage } from '../core/api/client';

function fmtSize(n: number | null | undefined): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
function isImgFile(f: ChatFile): boolean {
  return (
    !!f.is_image ||
    /^image\//.test(f.content_type || '') ||
    IMG_EXT.test(f.file_name || '')
  );
}

// 单张缩略图：异步解析 src（原生环境需经 OkHttp 拉取），未就绪时显示占位
function Thumb({ file }: { file: ChatFile }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const rawUrl = file.signed_path ?? file.url ?? file.file_url;
    if (!rawUrl) { setSrc(null); return; }
    loadFileImage(file.signed_path ?? rawUrl).then((s) => {
      if (alive) setSrc(s);
    });
    return () => { alive = false; };
  }, [file]);
  if (!src) {
    return (
      <div className="file-thumb-ph">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <circle cx="8.5" cy="8.5" r="1.6" />
          <path d="M21 15l-5-5-9 9" />
        </svg>
      </div>
    );
  }
  return <img src={src} alt={file.file_name ?? '图片'} className="file-image-thumb" />;
}

// 图片：内联网格缩略图（多图并排换行）
function FileImages({ files }: { files: ChatFile[] }) {
  const imgs = files.filter(isImgFile);
  if (imgs.length === 0) return null;
  return (
    <div className="file-images">
      {imgs.map((f, i) => (
        <Thumb key={(f as any).id ?? i} file={f} />
      ))}
    </div>
  );
}

// 文档占位
function FileCard({ f }: { f: ChatFile }) {
  const name: string = f?.file_name || '文件';
  const size = fmtSize(f?.file_size);
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

export default function FileAttachments({ files }: { files: ChatFile[] }) {
  if (!files || files.length === 0) return null;
  const images = files.filter((f) => f.is_image);
  const docs = files.filter((f) => !f.is_image);
  return (
    <>
      {images.length > 0 && <FileImages files={images} />}
      {docs.length > 0 && (
        <div className="file-attachments">
          {docs.map((f, i) => (
            <FileCard key={(f as any)?.id ?? i} f={f} />
          ))}
        </div>
      )}
    </>
  );
}