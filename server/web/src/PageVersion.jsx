import './PageVersion.css';

export function PageVersion({ rev }) {
  return (
    <span className="page-version" title={rev === 1 ? 'Page created' : undefined}>
      [ver {rev}]
    </span>
  );
}
