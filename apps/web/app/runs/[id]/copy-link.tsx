'use client';

import { useState } from 'react';

/** The run URL is the share link (no accounts by design); this just puts it on the clipboard. */
export function CopyLink() {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-muted px-3 py-1 text-sm"
      onClick={() => {
        void navigator.clipboard.writeText(window.location.href).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? 'Copied' : 'Copy link'}
    </button>
  );
}
