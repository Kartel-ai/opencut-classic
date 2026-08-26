import {
	Command,
	createElementSelectionResult,
	type CommandResult,
} from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { ElementRef, SceneTracks } from "@/timeline";

export class ApplyCrossfadeCommand extends Command {
	constructor({
		before,
		after,
		selectedElements,
	}: {
		before: SceneTracks;
		after: SceneTracks;
		selectedElements: ElementRef[];
	}) {
		super();
		this.before = before;
		this.after = after;
		this.selectedElements = selectedElements;
	}

	private readonly before: SceneTracks;
	private readonly after: SceneTracks;
	private readonly selectedElements: ElementRef[];

	execute(): CommandResult {
		EditorCore.getInstance().timeline.updateTracks(this.after);
		return createElementSelectionResult(this.selectedElements);
	}

	undo(): void {
		EditorCore.getInstance().timeline.updateTracks(this.before);
	}
}
