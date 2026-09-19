'use client';

import { useEffect, useRef, useState } from 'react';
import type { BreakToggle } from '@auditor/shared';
import {
  loadGtmContainer,
  loadMetaPixel,
  newEventId,
  trackMetaEvent,
} from '@/lib/meta-pixel-client.ts';

// A deliberately fake container. It 404s, which is fine: the auditor inspects the requests the
// page makes, and two requests for one container ID is the defect, whatever the response.
const DEMO_GTM_CONTAINER = 'GTM-AUD1T0R';

interface Props {
  pixelId: string;
  toggles: readonly BreakToggle[];
}

/**
 * The advertorial's own tracking: PageView on load. Real duplicate funnels fire a pixel on the
 * landing page, and the auditor's fire-order check expects to see it before the store's events.
 *
 * `consent_wall` gates everything behind a banner that most visitors never accept.
 * `strip_event_id` sends PageView without an event_id.
 * `duplicate_gtm` loads the same GTM container twice.
 */
export function AdvertorialPixel({ pixelId, toggles }: Props) {
  const consentWall = toggles.includes('consent_wall');
  const [consent, setConsent] = useState<'pending' | 'granted' | 'declined'>('pending');
  const fired = useRef(false);

  const blocked = consentWall && consent !== 'granted';

  useEffect(() => {
    // Once per page load. The ref also absorbs React's development-mode double effect, which
    // would otherwise be an accidental double_fire.
    if (blocked || fired.current) return;
    fired.current = true;

    loadMetaPixel(pixelId);
    trackMetaEvent('PageView', {}, toggles.includes('strip_event_id') ? null : newEventId());

    if (toggles.includes('duplicate_gtm')) {
      // Two installs of one container, as theme + app would produce. The second passes GTM's
      // `l` argument so the two requests are distinct on the wire; see loadGtmContainer.
      loadGtmContainer(DEMO_GTM_CONTAINER);
      loadGtmContainer(DEMO_GTM_CONTAINER, 'dataLayer');
    }
  }, [blocked, pixelId, toggles]);

  if (!consentWall || consent !== 'pending') return null;

  // A bottom bar, not a modal: real consent tools block tracking, not navigation. The shopper
  // can carry on into the store without ever answering, and the pixel never fires.
  return (
    <div
      role="dialog"
      aria-label="Cookie consent"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-neutral-300 bg-white px-4 py-3 text-sm shadow-lg"
    >
      <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3">
        <p className="text-neutral-700">
          We use cookies to measure our advertising. Accept to allow measurement cookies.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setConsent('declined')}
            className="rounded border border-neutral-400 px-3 py-1"
          >
            Decline
          </button>
          <button
            type="button"
            onClick={() => setConsent('granted')}
            className="rounded bg-neutral-900 px-3 py-1 text-white"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
