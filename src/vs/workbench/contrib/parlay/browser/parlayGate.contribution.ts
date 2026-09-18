/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Maquoketa Research. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

// Parlay: the sign-in gate. Until a Roblox session exists, an overlay covers the workbench below the title bar
// (window controls stay usable; notifications and dialogs stay above it, so sign-in errors are readable) with
// one button, Sign in with Roblox, which runs the Parlay extension's parlay.roblox.signIn. The extension
// registers the "roblox" authentication provider a moment after startup, so the gate waits for that, then for
// a session. The setting parlay.requireSignIn (default true, declared by the extension) turns it off.
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as WorkbenchExtensions, IWorkbenchContribution, IWorkbenchContributionsRegistry } from '../../../common/contributions.js';
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';

const PROVIDER = 'roblox';

class ParlayGate extends Disposable implements IWorkbenchContribution {

	private overlay: HTMLElement | undefined;
	private readonly listeners = this._register(new DisposableStore());

	constructor(
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService configurationService: IConfigurationService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) {
		super();
		if (configurationService.getValue<boolean>('parlay.requireSignIn') === false) {
			return;
		}
		this._register(this.authenticationService.onDidChangeSessions(e => { if (e.providerId === PROVIDER) { this.update(); } }));
		this._register(this.authenticationService.onDidRegisterAuthenticationProvider(e => { if (e.id === PROVIDER) { this.update(); } }));
		this._register(this.layoutService.onDidLayoutMainContainer(() => this.place()));
		this.update();
	}

	private async update(): Promise<void> {
		const ready = this.authenticationService.isAuthenticationProviderRegistered(PROVIDER);
		let signedIn = false;
		if (ready) {
			try {
				signedIn = (await this.authenticationService.getSessions(PROVIDER)).length > 0;
			} catch {
				// the provider is still starting; the next sessions event comes back here
			}
		}
		if (signedIn) {
			this.listeners.clear();
			this.overlay?.remove();
			this.overlay = undefined;
			this.layoutService.mainContainer.classList.remove('parlay-gated');
			return;
		}
		this.show(ready);
	}

	private show(ready: boolean): void {
		if (!this.overlay) {
			this.overlay = append(this.layoutService.mainContainer, $('.parlay-gate'));
		}
		// while gated the menu bar and the quick input are hidden too (style.css): no File > Open Folder, no F1 around it
		this.layoutService.mainContainer.classList.add('parlay-gated');
		this.listeners.clear();
		clearNode(this.overlay);
		this.place();
		const card = append(this.overlay, $('.parlay-gate-card'));
		append(card, $('.parlay-gate-logo'));
		append(card, $('h1')).textContent = localize('parlayGateTitle', "Welcome to Parlay");
		append(card, $('p')).textContent = localize('parlayGateText', "Sign in with your Roblox account to start. Parlay uses it to know who you are and to work with your places.");
		const button = append(card, $('button.parlay-gate-button')) as HTMLButtonElement;
		button.textContent = ready ? localize('parlayGateSignIn', "Sign in with Roblox") : localize('parlayGateStarting', "Starting…");
		button.disabled = !ready;
		this.listeners.add(addDisposableListener(button, EventType.CLICK, () => { this.commandService.executeCommand('parlay.roblox.signIn'); }));
		const quit = append(card, $('a.parlay-gate-quit'));
		quit.textContent = localize('parlayGateQuit', "Quit Parlay");
		this.listeners.add(addDisposableListener(quit, EventType.CLICK, () => { this.commandService.executeCommand('workbench.action.quit'); }));
		if (ready) {
			button.focus();
		}
	}

	// the overlay starts under the title row: in the stacked header that is the first 30px (the menu row below it
	// is hidden while gated), otherwise the whole title bar, so the window controls stay usable either way
	private place(): void {
		if (!this.overlay) {
			return;
		}
		const container = this.layoutService.mainContainer;
		const title = container.querySelector<HTMLElement>('.part.titlebar');
		this.overlay.style.top = container.classList.contains('parlay-stacked') ? '30px' : `${title?.offsetHeight ?? 30}px`;
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(ParlayGate, LifecyclePhase.Restored);
