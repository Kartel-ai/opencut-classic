# Successive soundtrack Keep snapshots

Scope: issue 11 of the fourteen-findings Studio repair. Exact editor base:
`a3fe6ea6680df9efaa9a90ffebe92b736a72a463`, the served RS-334 candidate on
`claude/vf-one-timeline-rs334-20261016`. This candidate changes one production
line in the `mix_preview` insertion path. It does not change editor startup,
export, media files, source identity, timing guards, deployment configuration,
or provider submission.

## Reproduction and repair

After Keep A, the live audio element retains an `AudioBuffer`. Before inserting
B, the bridge called `structuredClone(activeScene.tracks)`. Chromium rejects
that browser object. The asset is imported before this snapshot, so import can
succeed while insertion remains absent. Saving strips buffers from the stored
document but does not replace the live tracks.

The new browser regression executes the exact insertion block read from the
production bridge, the actual `soundtrackTracks` reducer, and the actual
`TracksSnapshotCommand`, with isolated editor-state adapters and real browser
`AudioBuffer` instances. On the unmodified base it exits 1 with:

```text
DataCloneError: Failed to execute 'structuredClone' on 'Window': AudioBuffer object could not be cloned.
```

The repair retains the immutable `activeScene.tracks` reference as the before
snapshot, matching `applyKartelTimelineEdits`. The soundtrack reducer creates
new affected track wrappers and preserves the original elements. Undo and redo
therefore retain the exact prior state and audio buffers, without serializing
or dropping audio caches.

## Local validation

Run with Node 24.16.0 and installed Chromium; `CHROME_PATH` can select a browser:

```text
node --test apps/web/src/kartel/__tests__/video-finisher-soundtrack-browser.test.mjs apps/web/src/kartel/__tests__/video-finisher-soundtrack.test.mjs apps/web/src/kartel/__tests__/video-finisher-take-fit.test.mjs
```

After the fix: 10 passed, 0 failed, 0 skipped. Whole-mix and effects cases each
verify two successive Keeps, unchanged original and A snapshots, exact A/B
buffer and media identity, picture preservation, correct mute states, original
stem mix state, two undo steps and two redo steps. The existing Solo rejection,
take-fit and source-range checks pass. Browser cleanup is bounded and validates
the owned temporary profile before removal. No authenticated session or remote
provider is used.

Production build: passed with exit 0 at 2026-10-18 04:59 UTC using the unchanged
`node ../../node_modules/next/dist/bin/next build` command from `apps/web`,
Next.js 16.3.3/Turbopack, DEV Studio origin and a candidate public revision stamp.
Compilation, TypeScript and all 18 static pages completed. Build-only placeholder
values satisfy the existing environment schema; no credentials were read.
Dependencies were copied locally from the existing editor installation
(76,383 files, 2,041,028,913 bytes), with identical `bun.lock` SHA-256
`63713dc8a6f1e516fe75a0dfe292c8c5d60b807e58fce7a0b3526628a3fd3e40`.
The initial junction-based attempt stopped before compilation because Turbopack
rejects a dependency symlink outside its Git root. A second attempt compiled
and type-checked but required the existing Freesound build placeholders for
page-data collection. The final build uses local dependency copies and those
placeholders. No compiler change, dependency installation or upgrade was used.

## Release boundary

Publish this isolated head as a draft PR against the exact served branch above.
The repository's existing CI only targets `main`, so a draft against the served
branch does not imply CI ran. Do not merge into the unrelated older `main`.
The DEV editor is manually released; publishing this candidate does not deploy
it. Exact commit review and separate manual DEV release approval are required.
Hosted same-project A-to-B acceptance remains pending. The local browser test
does not claim authenticated storage, production media playback, or creative
audio quality. Provider calls and spend for this repair: zero.
