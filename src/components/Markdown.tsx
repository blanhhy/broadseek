// Markdown 渲染组件：聊天气泡内容统一走这里
// react-markdown 默认不渲染原始 HTML，天然安全
// memo：相同 text 不重复解析，避免父组件重渲染时全量重解析

import { memo, Children, isValidElement, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

// react-markdown 默认把 li 内容包成块级 <p>，且渲染列表时会在 li 首尾插入换行文本节点。
// 二者会让 Chromium 把 ::marker 渲染到独立行（编号独占一行、文本从第二行开始）。
// 这里展开段落的包裹、并过滤掉空白文本节点，让编号与首行文本同行。
function cleanLiChildren(node: ReactNode): ReactNode {
  if (
    isValidElement<{ children?: ReactNode }>(node) &&
    node.type === 'p' &&
    node.props?.children != null
  ) {
    return node.props.children;
  }
  if (typeof node === 'string' && node.trim() === '') return null;
  return node;
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          // ol/ul 内部 li 之间也有 react-markdown 插入的空白文本节点，
          // Chromium 会把它们渲染成一整行的空隙；li 内同样有空白 + 段落包裹问题。
          // 统一用 cleanLiChildren 过滤空白、展开段落包裹。
          ol: ({ node: _n, children, ...props }) => (
            <ol {...props}>{Children.map(children, cleanLiChildren)}</ol>
          ),
          ul: ({ node: _n, children, ...props }) => (
            <ul {...props}>{Children.map(children, cleanLiChildren)}</ul>
          ),
          li: ({ node: _n, children, ...props }) => (
            <li {...props}>{Children.map(children, cleanLiChildren)}</li>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default memo(Markdown);