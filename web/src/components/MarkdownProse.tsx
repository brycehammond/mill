import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

// Render a markdown string with explicit dark-theme styling. We don't
// use @tailwindcss/typography because we only need this in three places
// (journal, decisions, profile) and the override CSS chain would be
// just as long. Per-tag styling is spelled out below.

const COMPONENTS: Components = {
  h1: ({ children }) => (
    <h1 className="font-mono text-lg text-ink-100 mt-4 mb-2 first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="font-mono text-base text-ink-100 mt-4 mb-2 first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="font-mono text-sm text-ink-100 mt-3 mb-1 first:mt-0">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="font-mono text-sm text-ink-200 mt-3 mb-1 first:mt-0">
      {children}
    </h4>
  ),
  p: ({ children }) => (
    <p className="text-sm text-ink-100 leading-relaxed my-2">{children}</p>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      className="text-blue-300 hover:text-blue-200 underline"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => (
    <ul className="list-disc list-outside pl-5 my-2 text-sm text-ink-100 space-y-1">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal list-outside pl-5 my-2 text-sm text-ink-100 space-y-1">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-ink-600 pl-3 my-2 text-ink-200 italic">
      {children}
    </blockquote>
  ),
  code: ({ children, className }) => {
    // ReactMarkdown gives `inline` via parent context; class names like
    // `language-foo` indicate fenced blocks. Style inline differently.
    const isFenced = !!className;
    if (isFenced) {
      return (
        <code className="font-mono text-xs text-ink-100">{children}</code>
      );
    }
    return (
      <code className="bg-ink-900 px-1 py-0.5 rounded font-mono text-xs text-ink-100">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="bg-ink-900 border border-ink-700 rounded p-2 my-2 overflow-x-auto text-xs">
      {children}
    </pre>
  ),
  hr: () => <hr className="my-4 border-ink-700" />,
  table: ({ children }) => (
    <div className="overflow-x-auto my-2">
      <table className="text-xs border border-ink-700 border-collapse">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-ink-900 text-ink-200">{children}</thead>
  ),
  th: ({ children }) => (
    <th className="border border-ink-700 px-2 py-1 text-left font-mono">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-ink-700 px-2 py-1 align-top">{children}</td>
  ),
  strong: ({ children }) => (
    <strong className="text-ink-100 font-semibold">{children}</strong>
  ),
  em: ({ children }) => <em className="text-ink-200">{children}</em>,
};

export function MarkdownProse({ source }: { source: string }) {
  return (
    <div className="markdown-prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
