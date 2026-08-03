"use client";

import type { DiscoveryFeedItem } from "@omnifin/contracts/discovery";
import { Info, Sparkles } from "lucide-react";
import dynamic from "next/dynamic";
import { useRef, useState } from "react";

import { discoveryItemIsRequestable, discoveryItemMedia } from "../lib/discovery-presentation";
import { DirectionalNavigationGroup } from "./directional-navigation-group";

const MediaDetailDrawer = dynamic(
  () => import("./media-detail-drawer").then((module) => module.MediaDetailDrawer),
  { ssr: false },
);
const RequestComposer = dynamic(
  () => import("./request-composer").then((module) => module.RequestComposer),
  { ssr: false },
);

export function DiscoveryHeroActions({ item }: { item: DiscoveryFeedItem }) {
  const media = discoveryItemMedia(item);
  const [detailOpen, setDetailOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [requested, setRequested] = useState(false);
  const returnFocusReference = useRef<HTMLElement | null>(null);
  const transitioningToComposerReference = useRef(false);

  function rememberFocus() {
    returnFocusReference.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  function restoreFocus() {
    requestAnimationFrame(() => returnFocusReference.current?.focus());
  }

  return (
    <>
      <DirectionalNavigationGroup className="hero-spotlight__actions">
        <button
          className="button button--primary"
          data-directional-item
          onClick={() => {
            rememberFocus();
            transitioningToComposerReference.current = false;
            setDetailOpen(true);
          }}
          type="button"
        >
          <Info aria-hidden="true" size={18} />
          View details
        </button>
        {discoveryItemIsRequestable(item) && !requested ? (
          <button
            className="button button--glass"
            data-directional-item
            onClick={() => {
              rememberFocus();
              transitioningToComposerReference.current = false;
              setComposerOpen(true);
            }}
            type="button"
          >
            <Sparkles aria-hidden="true" size={17} />
            Request title
          </button>
        ) : null}
      </DirectionalNavigationGroup>
      {detailOpen ? (
        <MediaDetailDrawer
          media={media}
          onOpenChange={(nextOpen) => {
            setDetailOpen(nextOpen);
            if (!nextOpen && !transitioningToComposerReference.current) restoreFocus();
          }}
          onRequest={() => {
            transitioningToComposerReference.current = true;
            setDetailOpen(false);
            setComposerOpen(true);
          }}
          open
        />
      ) : null}
      {composerOpen ? (
        <RequestComposer
          media={media}
          onCreated={() => setRequested(true)}
          onOpenChange={(nextOpen) => {
            setComposerOpen(nextOpen);
            if (!nextOpen) {
              transitioningToComposerReference.current = false;
              restoreFocus();
            }
          }}
          open
        />
      ) : null}
    </>
  );
}
