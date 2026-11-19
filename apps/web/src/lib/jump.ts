import type { MouseEvent } from 'react';

/** In-page anchor: scroll to the element without touching the hash, which is the router's (App.tsx). */
export function jumpTo(id: string) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ block: 'start' });
  };
}
