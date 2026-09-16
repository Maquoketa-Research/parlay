/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Maquoketa Research. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

// Parlay: the Roblox avatar in the title bar. Click it for the integrations menu: every account and key Parlay
// holds, with the handle it is signed in as and the action that changes it (the Parlay extension answers
// 'parlay.accounts.summary' and runs 'parlay.accounts.do'), then "Accounts…" for the full page. The avatar is
// the session account's icon (API proposal authSessionAccountIcon), filled by the extension from Roblox's
// thumbnails API; before sign-in it is the account glyph. Only the main window has one; auxiliary windows keep
// the stock accounts action.
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { IAction, Separator, SubmenuAction, toAction } from '../../../../base/common/actions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { AuthenticationSession, IAuthenticationService } from '../../../services/authentication/common/authentication.js';

const PROVIDER = 'roblox';

// what the extension's 'parlay.accounts.summary' returns: one row per integration
interface AccountRow { title: string; status: string; ok: boolean; icon?: string; actions: { label: string; msg: unknown }[] }

export class ParlayAccountWidget extends Disposable {

	private readonly element: HTMLElement;

	constructor(
		container: HTMLElement,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
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

	private async open(): Promise<void> {
		let rows: AccountRow[] = [];
		try {
			rows = (await this.commandService.executeCommand<AccountRow[]>('parlay.accounts.summary')) ?? [];
		} catch {
			// the extension is not up yet: the menu below still offers sign-in and the page
		}
		const run = (id: string, ...args: unknown[]) => { this.commandService.executeCommand(id, ...args); };
		const actions: IAction[] = rows.map((row, i) => new SubmenuAction(`parlay.account.${i}`, `${row.title}  ·  ${row.status}`,
			row.actions.map((a, j) => toAction({ id: `parlay.account.${i}.${j}`, label: a.label, run: () => run('parlay.accounts.do', a.msg) })),
			row.icon ? `codicon codicon-${row.icon}` : undefined));
		if (!actions.length) {
			actions.push(toAction({ id: 'parlay.account.signIn', label: localize('parlaySignInRoblox', "Sign in to Roblox"), run: () => run('parlay.roblox.signIn') }));
		}
		actions.push(new Separator(), toAction({ id: 'parlay.account.page', label: localize('parlayAccountsPage', "Accounts…"), run: () => run('parlay.accounts') }));
		this.contextMenuService.showContextMenu({ getAnchor: () => this.element, getActions: () => actions });
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
		clearNode(this.element);
		this.element.classList.toggle('signed-in', !!session);
		if (session?.account.icon) {
			const img = append(this.element, $('img.parlay-avatar')) as HTMLImageElement;
			img.src = session.account.icon.toString(true);
			img.alt = '';
			img.draggable = false;
		} else {
			append(this.element, $('span.codicon.codicon-account'));
		}
		this.element.title = session
			? localize('parlayAccount', "{0} on Roblox. Accounts and integrations", session.account.label)
			: localize('parlaySignInTitle', "Sign in. Accounts and integrations");
	}
}
