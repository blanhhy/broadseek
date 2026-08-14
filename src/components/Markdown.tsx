// Markdown 渲染组件：聊天气泡内容统一走这里
// react-markdown 默认不渲染原始 HTML，天然安全
// memo：相同 text 不重复解析，避免父组件重渲染时全量重解析

import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{text}</ReactMarkdown>
    </div>
  );
}

export default memo(Markdown);