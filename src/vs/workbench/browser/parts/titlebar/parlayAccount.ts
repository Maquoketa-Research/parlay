/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Maquoketa Research. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

// Parlay: the Roblox account in the title bar. Avatar and name when signed in (click: the Accounts page),
// "Sign in" when not. Sessions come from the Parlay extension's "roblox" authentication provider; the avatar
// is the session account's icon (API proposal authSessionAccountIcon), which the extension fills from
// Roblox's thumbnails API. Only the main window has one; auxiliary windows keep the stock accounts action.
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { AuthenticationSession, IAuthenticationService } from '../../../services/authentication/common/authentication.js';

const PROVIDER = 'roblox';

export class ParlayAccountWidget extends Disposable {

	private readonly element: HTMLElement;
	private session: AuthenticationSession | undefined;

	constructor(
		container: HTMLElement,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this.element = append(container, $('div.parlay-account'));
		this.element.setAttribute('role', 'button');
		this.element.tabIndex = 0;
		this._register(addDisposableListener(this.element, EventType.CLICK, () => this.open()));
		this._register(addDisposableListener(this.element, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				this.open();
			}
		}));
		this._register(this.authenticationService.onDidChangeSessions(e => { if (e.providerId === PROVIDER) { this.update(); } }));
		this._register(this.authenticationService.onDidRegisterAuthenticationProvider(e => { if (e.id === PROVIDER) { this.update(); } }));
		this._register(this.authenticationService.onDidUnregisterAuthenticationProvider(e => { if (e.id === PROVIDER) { this.update(); } }));
		this.update();
	}

	private open(): void {
		this.commandService.executeCommand(this.session ? 'parlay.accounts' : 'parlay.roblox.signIn');
	}

	private async update(): Promise<void> {
		let session: AuthenticationSession | undefined;
		if (this.authenticationService.isAuthenticationProviderRegistered(PROVIDER)) {
			try {
				session = (await this.authenticationService.getSessions(PROVIDER))[0];
			} catch {
				// the provider is still starting; the next sessions event redraws
			}
		}
		this.session = session;
		clearNode(this.element);
		this.element.classList.toggle('signed-in', !!session);
		if (session) {
			const name = session.account.label.replace(/\s*\(@[^)]*\)\s*$/, '');   // "Display (@name)" reads as Display up here
			if (session.account.icon) {
				const img = append(this.element, $('img.parlay-avatar')) as HTMLImageElement;
				img.src = session.account.icon.toString(true);
				img.alt = '';
				img.draggable = false;
			} else {
				append(this.element, $('span.codicon.codicon-account'));
			}
			append(this.element, $('span.parlay-account-name')).textContent = name;
			this.element.title = localize('parlayAccount', "{0} on Roblox. Accounts…", name);
		} else {
			append(this.element, $('span.codicon.codicon-account'));
			append(this.element, $('span.parlay-account-name')).textContent = localize('parlaySignIn', "Sign in");
			this.element.title = localize('parlaySignInTitle', "Sign in to Roblox");
		}
	}
}
