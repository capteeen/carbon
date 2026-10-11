import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Renders a /docs Markdown file verbatim (GFM tables; raw HTML such as the generator markers is skipped). */
export function Markdown({ source }: { source: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
        {source}
      </ReactMarkdown>
    </div>
  );
}
