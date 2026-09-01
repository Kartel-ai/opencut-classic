"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { useEditor } from "@/editor/use-editor";
import { ApplyCrossfadeCommand } from "@/commands/timeline";
import { generateUUID } from "@/utils/id";
import { mediaTimeFromSeconds, ZERO_MEDIA_TIME } from "@/wasm";
import {
	analyzeCrossfadeSelection,
	buildCrossfadePlan,
	CROSSFADE_DURATION_LIMITS,
} from "@/transitions/crossfade";

export function TransitionsView() {
	const editor = useEditor();
	const tracks = useEditor(
		(instance) => instance.scenes.getActiveSceneOrNull()?.tracks ?? null,
	);
	const selectedElements = useEditor((instance) =>
		instance.selection.getSelectedElements(),
	);
	const [durationInput, setDurationInput] = useState("0.5");
	const [includeAudio, setIncludeAudio] = useState(true);
	const durationSeconds = Number(durationInput);
	const duration = useMemo(
		() =>
			Number.isFinite(durationSeconds) && durationSeconds > 0
				? mediaTimeFromSeconds({ seconds: durationSeconds })
				: ZERO_MEDIA_TIME,
		[durationSeconds],
	);
	const analysis = useMemo(
		() =>
			tracks
				? analyzeCrossfadeSelection({
						tracks,
						selectedElements,
						duration,
						includeAudio,
					})
				: {
						ok: false as const,
						reason: "Open a project to apply a transition.",
					},
		[tracks, selectedElements, duration, includeAudio],
	);

	const handleApply = () => {
		const currentTracks = editor.scenes.getActiveSceneOrNull()?.tracks;
		if (!currentTracks) {
			toast.error("Open a project to apply a transition");
			return;
		}

		try {
			const plan = buildCrossfadePlan({
				tracks: currentTracks,
				selectedElements: editor.selection.getSelectedElements(),
				duration,
				includeAudio,
				idFactory: generateUUID,
			});
			editor.command.execute({
				command: new ApplyCrossfadeCommand({
					before: currentTracks,
					after: plan.tracks,
					selectedElements: plan.selectedElements,
				}),
			});
			toast.success("Crossfade applied", {
				description: `${durationSeconds}s overlap${includeAudio ? " with source-audio fade" : ""}.`,
			});
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not apply crossfade",
			);
		}
	};

	return (
		<PanelView title="Transitions">
			<div className="flex flex-col gap-3 pb-4">
				<div className="rounded-md border bg-muted/20 p-3">
					<div className="mb-3 flex h-16 items-center justify-center overflow-hidden rounded bg-background">
						<div className="h-9 w-24 translate-x-3 rounded-sm bg-foreground/80" />
						<div className="h-9 w-24 -translate-x-3 rounded-sm border border-foreground/20 bg-muted opacity-70" />
					</div>
					<div className="mb-1 text-sm font-medium">Crossfade</div>
					<p className="text-muted-foreground text-xs leading-relaxed">
						Overlap two adjacent video clips and fade smoothly between them.
					</p>
				</div>

				<div className="rounded-md border p-3">
					<label
						htmlFor="crossfade-duration"
						className="mb-1.5 block text-xs font-medium"
					>
						Duration
					</label>
					<div className="flex items-center gap-2">
						<Input
							id="crossfade-duration"
							type="number"
							min={CROSSFADE_DURATION_LIMITS.minSeconds}
							max={CROSSFADE_DURATION_LIMITS.maxSeconds}
							step="0.1"
							size="sm"
							value={durationInput}
							onChange={(event) => setDurationInput(event.target.value)}
							aria-describedby="crossfade-duration-unit"
						/>
						<span
							id="crossfade-duration-unit"
							className="text-muted-foreground text-xs"
						>
							seconds
						</span>
					</div>

					<div className="mt-3 flex items-center gap-2 text-xs">
						<Checkbox
							id="crossfade-audio"
							checked={includeAudio}
							onCheckedChange={(checked) => setIncludeAudio(checked === true)}
						/>
						<label htmlFor="crossfade-audio" className="cursor-pointer">
							Fade source audio with the picture
						</label>
					</div>
				</div>

				<div
					className="text-muted-foreground min-h-10 rounded-md border border-dashed px-3 py-2 text-xs leading-relaxed"
					aria-live="polite"
				>
					{analysis.ok
						? `${analysis.outgoing.element.name} → ${analysis.incoming.element.name} is ready. The incoming clip will move onto a new video layer and following clips will stay continuous.`
						: analysis.reason}
				</div>

				<Button
					onClick={handleApply}
					disabled={!analysis.ok}
					className="w-full"
				>
					Apply crossfade
				</Button>
			</div>
		</PanelView>
	);
}
