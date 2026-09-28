// "11estates" placeholder wordmark (questionnaire A10: simple, replaceable, prototype look).
import Link from 'next/link';

export function Wordmark({ href = '/', tag = 'CRM' }: { href?: string | null; tag?: string }) {
  const inner = (
    <>
      <span className="word" aria-hidden="true">
        <em>11</em>estates
      </span>
      <span className="tag" aria-hidden="true">
        {tag}
      </span>
      <span className="sr-only">11estates {tag}</span>
    </>
  );
  return href ? (
    <Link href={href} className="brand">
      {inner}
    </Link>
  ) : (
    <div className="brand">{inner}</div>
  );
}
