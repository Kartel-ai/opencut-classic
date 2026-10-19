"use client";

import { useParams, usePathname } from "next/navigation";
import {
	ResizablePanelGroup,
	ResizablePanel,
	ResizableHandle,
} from "@/components/ui/resizable";
import { AssetsPanel } from "@/components/editor/panels/assets";
import { PropertiesPanel } from "@/components/editor/panels/properties";
import { Timeline } from "@/timeline/components";
import { PreviewPanel } from "@/preview/components";
import { EditorHeader } from "@/components/editor/editor-header";
import { EditorProvider } from "@/components/providers/editor-provider";
import { Onboarding } from "@/components/editor/onboarding";
import { MigrationDialog } from "@/project/components/migration-dialog";
import { usePanelStore } from "@/editor/panel-store";
import { usePasteMedia } from "@/media/use-paste-media";
import { MobileGate } from "@/components/editor/mobile-gate";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "next-themes";
import type { ImperativePanelHandle } from "react-resizable-panels";
import { getTrackHeight } from "@/timeline/components/track-layout";
import { useEditor } from "@/editor/use-editor";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/components/ui/button";
import { ChangelogNotification } from "@/changelog/components/changelog-notification";
import {
	createPreviewOverlayControl,
	isPreviewOverlayVisible,
	mergePreviewOverlaySources,
} from "@/preview/overlays";
import { usePreviewStore } from "@/preview/preview-store";
import { getGuidePreviewOverlaySource } from "@/guides";
import {
	bookmarkNotesPreviewOverlay,
	getBookmarkPreviewOverlaySource,
} from "@/timeline/bookmarks/index";
import { KartelVideoFinisherBridge } from "@/kartel/video-finisher-bridge";
import { useKartelLayout } from "@/kartel/video-finisher-layout";
import { kartelTimelineShare as kartelTimelineShareFor } from "@/kartel/video-finisher-studio-look";
import {
	isKartelVideoFinisherRoute,
	shouldShowEditorMobileGate,
	shouldShowStandaloneEditorChrome,
} from "@/kartel/video-finisher-protocol";

export default function Editor() {
	const params = useParams();
	const pathname = usePathname();
	const projectId = Array.isArray(params.project_id)
		? (params.project_id[0] ?? "")
		: (params.project_id ?? "");
	const isKartelEmbed = isKartelVideoFinisherRoute(pathname);
	const showStandaloneChrome = shouldShowStandaloneEditorChrome(pathname);
	const showMobileGate = shouldShowEditorMobileGate(pathname);

	return (
		<MobileGate enabled={showMobileGate}>
			<EditorProvider projectId={projectId} preserveProjectId={isKartelEmbed}>
				{isKartelEmbed ? (
					<KartelVideoFinisherBridge projectId={projectId} />
				) : null}
				<div className="bg-background flex h-screen w-screen flex-col overflow-hidden">
					<DegradedRendererBanner />
					{showStandaloneChrome ? <EditorHeader /> : null}
					<div className="min-h-0 min-w-0 flex-1">
						<EditorLayout />
					</div>
					{showStandaloneChrome ? <Onboarding /> : null}
					<MigrationDialog />
					{showStandaloneChrome ? <ChangelogNotification /> : null}
				</div>
			</EditorProvider>
		</MobileGate>
	);
}

function DegradedRendererBanner() {
	const isDegraded = useEditor((e) => e.renderer.isDegraded);
	const [dismissed, setDismissed] = useState(false);
	if (!isDegraded || dismissed) return null;

	return (
		<div className="bg-accent border-b h-9 flex items-center justify-center gap-2 text-xs text-muted-foreground">
			<span>For the best experience, open OpenCut in Chrome.</span>
			<Button
				variant="text"
				size="icon"
				className="p-0 w-auto [&_svg]:size-3.5"
				onClick={() => setDismissed(true)}
				aria-label="Dismiss"
			>
				<HugeiconsIcon icon={Cancel01Icon} />
			</Button>
		</div>
	);
}

function EditorLayout() {
	usePasteMedia();
	const { panels, setPanel } = usePanelStore();
	// RS-067 mock: inside Studio the editor is the preview and the timeline; the host's Advanced
	// switch brings OpenCut's assets and properties panels back.
	const kartelCompact = useKartelLayout((state) => state.compact);
	const kartelTimelineShown = useKartelLayout((state) => state.timeline);
	// RS-366: with Studio's timeline head as the transport, the stage picture fills the frame.
	const kartelTransportHidden = useKartelLayout((state) => state.transportHidden);
	const activeScene = useEditor((editor) =>
		editor.scenes.getActiveSceneOrNull(),
	);
	// RS-067 mock: the compact embed sizes the timeline to its lanes (toolbar, ruler and each lane),
	// between 26% and 62% of the frame, and the preview takes the rest; it resizes as lanes arrive.
	const kartelTimelineRef = useRef<ImperativePanelHandle>(null);
	const kartelLanePixels = activeScene
		? [...activeScene.tracks.overlay, activeScene.tracks.main, ...activeScene.tracks.audio].reduce((sum, track) => sum + getTrackHeight({ type: track.type }) + 6, 0)
		: 71;
	// RS-283: the share follows the frame's live height, so a frame that opened short and then grew
	// gives the preview back the room (it was read from innerHeight once per render).
	const [kartelFrameHeight, setKartelFrameHeight] = useState(() => (typeof window === "undefined" ? 0 : window.innerHeight));
	useEffect(() => {
		const update = () => setKartelFrameHeight(window.innerHeight);
		window.addEventListener("resize", update);
		update();
		return () => window.removeEventListener("resize", update);
	}, []);
	const kartelTimelineShare = kartelTimelineShareFor({ lanePixels: kartelLanePixels, frameHeight: kartelFrameHeight });
	// RS-283: inside Studio the editor wears Studio's theme (sent by Studio, not the computer's)
	// and marks the document so the Kartel colours in globals.css apply only there.
	const kartelEmbedded = useKartelLayout((state) => state.embedded);
	const kartelTheme = useKartelLayout((state) => state.theme);
	const { setTheme } = useTheme();
	useEffect(() => {
		if (!kartelEmbedded) return;
		document.documentElement.dataset.kartelEmbed = "";
		if (kartelTheme) setTheme(kartelTheme);
	}, [kartelEmbedded, kartelTheme, setTheme]);
	useEffect(() => {
		if (kartelCompact) kartelTimelineRef.current?.resize(kartelTimelineShare);
	}, [kartelCompact, kartelTimelineShare]);
	const currentTime = useEditor((editor) => editor.playback.getCurrentTime());
	const activeGuide = usePreviewStore((state) => state.activeGuide);
	const overlays = usePreviewStore((state) => state.overlays);
	const setOverlayVisibility = usePreviewStore(
		(state) => state.setOverlayVisibility,
	);
	const showBookmarkNotes = isPreviewOverlayVisible({
		overlay: bookmarkNotesPreviewOverlay,
		overlays,
	});

	const overlaySource = useMemo(
		() =>
			mergePreviewOverlaySources({
				sources: [
					getGuidePreviewOverlaySource({
						guideId: activeGuide,
					}),
					activeScene
						? getBookmarkPreviewOverlaySource({
								bookmarks: activeScene.bookmarks,
								time: currentTime,
								isVisible: showBookmarkNotes,
							})
						: {
								definitions: [bookmarkNotesPreviewOverlay],
								instances: [],
							},
				],
			}),
		[activeGuide, activeScene, currentTime, showBookmarkNotes],
	);

	const overlayControls = useMemo(
		() =>
			overlaySource.definitions.map((overlay) =>
				createPreviewOverlayControl({ overlay, overlays }),
			),
		[overlaySource.definitions, overlays],
	);

	// RS-313: the stage layout is the picture alone; Studio draws the shots under it.
	if (kartelCompact && !kartelTimelineShown) {
		return (
			<div className={kartelTransportHidden ? "size-full min-h-0 min-w-0" : "size-full min-h-0 min-w-0 p-3"}>
				<PreviewPanel
					overlayControls={overlayControls}
					overlayInstances={overlaySource.instances}
					onOverlayVisibilityChange={setOverlayVisibility}
				/>
			</div>
		);
	}

	return (
		<ResizablePanelGroup
			direction="vertical"
			className="size-full gap-[0.18rem]"
			onLayout={(sizes) => {
				setPanel({
					panel: "mainContent",
					size: sizes[0] ?? panels.mainContent,
				});
				setPanel({
					panel: "timeline",
					size: sizes[1] ?? panels.timeline,
				});
			}}
		>
			<ResizablePanel
				defaultSize={kartelCompact ? 100 - kartelTimelineShare : panels.mainContent}
				minSize={30}
				maxSize={85}
				className="min-h-0"
			>
				{kartelCompact ? (
					<div className="size-full min-h-0 min-w-0 px-3 pt-3">
						<PreviewPanel
							overlayControls={overlayControls}
							overlayInstances={overlaySource.instances}
							onOverlayVisibilityChange={setOverlayVisibility}
						/>
					</div>
				) : (
				<ResizablePanelGroup
					direction="horizontal"
					className="size-full gap-[0.19rem] px-3"
					onLayout={(sizes) => {
						setPanel({ panel: "tools", size: sizes[0] ?? panels.tools });
						setPanel({ panel: "preview", size: sizes[1] ?? panels.preview });
						setPanel({
							panel: "properties",
							size: sizes[2] ?? panels.properties,
						});
					}}
				>
					<ResizablePanel
						defaultSize={panels.tools}
						minSize={15}
						maxSize={40}
						className="min-w-0"
					>
						<AssetsPanel />
					</ResizablePanel>

					<ResizableHandle withHandle />

					<ResizablePanel
						defaultSize={panels.preview}
						minSize={30}
						className="min-h-0 min-w-0 flex-1"
					>
						<PreviewPanel
							overlayControls={overlayControls}
							overlayInstances={overlaySource.instances}
							onOverlayVisibilityChange={setOverlayVisibility}
						/>
					</ResizablePanel>

					<ResizableHandle withHandle />

					<ResizablePanel
						defaultSize={panels.properties}
						minSize={15}
						maxSize={40}
						className="min-w-0"
					>
						<PropertiesPanel />
					</ResizablePanel>
				</ResizablePanelGroup>
				)}
			</ResizablePanel>

			<ResizableHandle withHandle />

			<ResizablePanel
				ref={kartelTimelineRef}
				defaultSize={kartelCompact ? kartelTimelineShare : panels.timeline}
				minSize={15}
				maxSize={70}
				className="min-h-0 px-3 pb-3"
			>
				<Timeline />
			</ResizablePanel>
		</ResizablePanelGroup>
	);
}
