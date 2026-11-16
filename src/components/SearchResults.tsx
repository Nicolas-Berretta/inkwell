import { useEffect, useMemo, useState } from 'react';
import { searchPages } from '../db/search';
import { getSearchTexts, useAppStore } from '../store/appStore';

interface SearchResultsProps {
  query: string;
  onNavigate: () => void;
}

/** Instant search across every page title and all typed text; results jump to the page. */
export function SearchResults({ query, onNavigate }: SearchResultsProps) {
  const pages = useAppStore((s) => s.pages);
  const sections = useAppStore((s) => s.sections);
  const notebooks = useAppStore((s) => s.notebooks);
  const selectPage = useAppStore((s) => s.selectPage);
  const [texts, setTexts] = useState<Array<{ pageId: string; text: string }> | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSearchTexts()
      .then((rows) => {
        if (!cancelled) setTexts(rows);
      })
      .catch(() => {
        if (!cancelled) setTexts([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const results = useMemo(() => searchPages(query, pages, texts ?? []), [query, pages, texts]);

  const locationOf = (pageId: string): string => {
    const page = pages.find((p) => p.id === pageId);
    const section = page ? sections.find((s) => s.id === page.sectionId) : undefined;
    const notebook = section ? notebooks.find((n) => n.id === section.notebookId) : undefined;
    return [notebook?.name, section?.name].filter(Boolean).join(' › ');
  };

  return (
    <div className="search-results" role="listbox" aria-label="Search results">
      {results.map((result) => {
        const page = pages.find((p) => p.id === result.pageId);
        const before = result.snippet.slice(0, result.matchStart);
        const match = result.snippet.slice(result.matchStart, result.matchStart + result.matchLength);
        const after = result.snippet.slice(result.matchStart + result.matchLength);
        return (
          <button
            key={result.pageId}
            type="button"
            role="option"
            aria-selected="false"
            className="search-result"
            onClick={() => {
              void selectPage(result.pageId);
              onNavigate();
            }}
          >
            <span className="search-result-title">
              {result.source === 'title' ? (
                <>
                  {before}
                  <mark>{match}</mark>
                  {after}
                </>
              ) : (
                page?.title || 'Untitled page'
              )}
            </span>
            {result.source === 'text' ? (
              <span className="search-result-snippet">
                {before}
                <mark>{match}</mark>
                {after}
              </span>
            ) : null}
            <span className="search-result-location">{locationOf(result.pageId)}</span>
          </button>
        );
      })}
      {results.length === 0 ? (
        <p className="pane-empty">{texts === null ? 'Searching…' : 'No pages match your search.'}</p>
      ) : null}
    </div>
  );
}
