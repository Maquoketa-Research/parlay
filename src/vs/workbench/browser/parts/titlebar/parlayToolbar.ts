/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Maquoketa Research. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType, getWindow } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

/** Project actions for the second Mac titlebar row. Standard menus stay in the system menu bar. */
export class ParlayToolbar extends Disposable {

	constructor(
		container: HTMLElement,
		@ICommandService commandService: ICommandService,
		@IWorkspaceContextService workspaceService: IWorkspaceContextService,
		@INotificationService notificationService: INotificationService,
	) {
		super();
		const root = append(container, $('.parlay-project-toolbar', { role: 'group', 'aria-label': localize('parlayProjectActions', "Project actions") }));
		this._register(toDisposable(() => root.remove()));
		const button = (icon: string, label: string, command: string, tooltip: string) => {
			const element = append(root, $('button', { type: 'button', title: tooltip, 'aria-label': tooltip })) as HTMLButtonElement;
			append(element, $(`span.codicon.codicon-${icon}`, { 'aria-hidden': 'true' }));
			const text = append(element, $('span.label'));
			text.textContent = label;
			this._register(addDisposableListener(element, EventType.CLICK, () => {
				commandService.executeCommand(command).catch(error => notificationService.error(error));
			}));
			return { element, text };
		};
		const project = button('folder-opened', '', 'parlay.project.select', localize('parlayChooseProject', "Choose a game project"));
		project.element.classList.add('project-picker');
		append(project.element, $('span.codicon.codicon-chevron-down', { 'aria-hidden': 'true' }));
		const sync = button('sync', localize('parlaySync', "Script Sync"), 'parlay.scriptSync', localize('parlaySyncSetup', "Set up Script Sync for this project"));
		button('source-control', localize('parlayChanges', "Changes"), 'workbench.view.scm', localize('parlayChangesHint', "Review source control changes"));
		button('warning', localize('parlayProblems', "Problems"), 'workbench.actions.view.problems', localize('parlayProblemsHint', "Show errors and warnings"));
		append(root, $('span.toolbar-spacer', { 'aria-hidden': 'true' }));
		button('debug-alt', localize('parlayOpenStudio', "Open Studio"), 'parlay.studio.open', localize('parlayOpenStudioHint', "Open Roblox Studio to playtest"));
		button('parlay-aqua', localize('parlayAqua', "Aqua"), 'parlay.aqua.show', localize('parlayAquaOpen', "Open Aqua"));
		button('comment-discussion', localize('parlayChat', "Chat"), 'parlay.chat.open', localize('parlayChatHint', "Open Parlay Chat"));
		const resize = new (getWindow(root).ResizeObserver)(entries => root.classList.toggle('compact', entries[0].contentRect.width < 800));
		resize.observe(root);
		this._register(toDisposable(() => resize.disconnect()));
		const update = () => {
			const folders = workspaceService.getWorkspace().folders;
			project.text.textContent = folders.length ? folders[0].name : localize('parlayOpenProject', "Open Game Project");
			sync.element.disabled = folders.length === 0;
			sync.element.title = folders.length ? localize('parlaySyncSetup', "Set up Script Sync for this project") : localize('parlaySyncNoProject', "Open a game project to set up Script Sync");
			sync.element.setAttribute('aria-label', sync.element.title);
		};
		this._register(workspaceService.onDidChangeWorkspaceFolders(update));
		this._register(workspaceService.onDidChangeWorkbenchState(update));
		update();
	}
}
