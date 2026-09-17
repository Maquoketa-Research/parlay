/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Maquoketa Research. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

// Parlay: the Roblox avatar in the title bar. Click it for the integrations popover: who you are on Roblox, then
// one row per integration with its mark, the handle or key state it has, and the one action that changes it;
// "Accounts…" at the bottom for the full page. The Parlay extension answers 'parlay.accounts.summary' (rows with
// marks as data URIs) and runs 'parlay.accounts.do'. The avatar is the session account's icon (API proposal
// authSessionAccountIcon), filled by the extension from Roblox's thumbnails API; before sign-in it is the
// account glyph. Only the main window has one; auxiliary windows keep the stock accounts action.
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { AnchorAlignment, AnchorPosition } from '../../../../base/browser/ui/contextview/contextview.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { AuthenticationSession, IAuthenticationService } from '../../../services/authentication/common/authentication.js';

const PROVIDER = 'roblox';

// what the extension's 'parlay.accounts.summary' returns: one row per integration
interface AccountRow { title: string; status: string; ok: boolean; avatar?: string; brandData?: string; actions: { label: string; msg: unknown; quiet?: boolean }[] }

export class ParlayAccountWidget extends Disposable {

	private readonly element: HTMLElement;

	constructor(
		container: HTMLElement,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextViewService private readonly contextViewService: IContextViewService,
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

	private async session(): Promise<AuthenticationSession | undefined> {
		if (!this.authenticationService.isAuthenticationProviderRegistered(PROVIDER)) {
			return undefined;
		}
		try {
			return (await this.authenticationService.getSessions(PROVIDER))[0];
		} catch {
			return undefined;   // the provider is still starting; the next sessions event redraws
		}
	}

	private async open(): Promise<void> {
		const [session, rows] = await Promise.all([
			this.session(),
			this.commandService.executeCommand<AccountRow[]>('parlay.accounts.summary').then(r => r ?? [], () => [] as AccountRow[]),
		]);
		const run = (id: string, ...args: unknown[]) => { this.contextViewService.hideContextView(); this.commandService.executeCommand(id, ...args); };
		this.contextViewService.showContextView({
			getAnchor: () => this.element,
			anchorAlignment: AnchorAlignment.RIGHT,
			anchorPosition: AnchorPosition.BELOW,
			render: (container) => {
				const store = new DisposableStore();
				const root = append(container, $('.parlay-account-popover'));
				const on = (el: HTMLElement, fn: () => void) => store.add(addDisposableListener(el, EventType.CLICK, fn));

				// who you are
				const roblox = rows.find(r => r.title === 'Roblox');
				const head = append(root, $('.pa-head'));
				if (session) {
					const name = session.account.label.replace(/\s*\(@[^)]*\)\s*$/, '');
					const handle = /\(@([^)]*)\)/.exec(session.account.label)?.[1];
					if (session.account.icon) {
						const img = append(head, $('img.pa-avatar')) as HTMLImageElement;
						img.src = session.account.icon.toString(true);
						img.alt = '';
					} else {
						append(head, $('span.pa-avatar.codicon.codicon-account'));
					}
					const who = append(head, $('.pa-who'));
					append(who, $('.pa-name')).textContent = name;
					append(who, $('.pa-handle')).textContent = handle ? `@${handle}` : localize('parlayOnRoblox', "on Roblox");
					const out = roblox?.actions.find(a => /sign out/i.test(a.label));
					if (out) {
						const b = append(head, $('button.pa-button.quiet')) as HTMLButtonElement;
						b.textContent = out.label;
						on(b, () => run('parlay.accounts.do', out.msg));
					}
				} else {
					append(head, $('span.pa-avatar.codicon.codicon-account'));
					const who = append(head, $('.pa-who'));
					append(who, $('.pa-name')).textContent = localize('parlayNotSignedIn', "Not signed in");
					append(who, $('.pa-handle')).textContent = localize('parlaySignInHint', "Roblox is your Parlay account");
					const b = append(head, $('button.pa-button')) as HTMLButtonElement;
					b.textContent = localize('parlaySignInRoblox', "Sign in");
					on(b, () => run('parlay.roblox.signIn'));
				}

				// the integrations
				const list = append(root, $('.pa-rows'));
				for (const row of rows.filter(r => r.title !== 'Roblox')) {
					const line = append(list, $('.pa-row'));
					if (row.avatar) {
						const img = append(line, $('img.pa-mark.round')) as HTMLImageElement;
						img.src = row.avatar;
						img.alt = '';
					} else if (row.brandData) {
						const img = append(line, $('img.pa-mark')) as HTMLImageElement;
						img.src = row.brandData;
						img.alt = '';
					} else {
						append(line, $('.pa-mark.mono')).textContent = row.title.slice(0, 3);
					}
					const text = append(line, $('.pa-text'));
					append(text, $('.pa-title')).textContent = row.title;
					const status = append(text, $('.pa-status'));
					status.textContent = row.status;
					status.classList.toggle('ok', row.ok);
					const first = row.actions[0];
					if (first) {
						const b = append(line, $('button.pa-button')) as HTMLButtonElement;
						b.classList.toggle('quiet', !!first.quiet || row.ok);
						b.textContent = first.label;
						on(b, () => run('parlay.accounts.do', first.msg));
					}
				}
				if (!rows.length) {
					append(list, $('.pa-empty')).textContent = localize('parlayStarting', "Parlay is starting…");
				}

				const foot = append(root, $('a.pa-foot'));
				foot.textContent = localize('parlayAccountsPage', "Accounts…");
				on(foot, () => run('parlay.accounts'));
				return store;
			},
		});
	}

	private async update(): Promise<void> {
		const session = await this.session();
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
