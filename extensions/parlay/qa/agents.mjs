// The personalities: what Jev is offered, what it is asked, and when it may call the session done. The runner,
// the Studio bridge, the console classifier and the report are shared; an agent is only this table.
//   offers:  buttons / interactables / walks (true, false, or "explore" for a single "go find more" walk),
//            repeat (visited targets stay on offer), spam (use a prompt five times, run at edges)
//   notes:   extra yes/no questions; 0.7 or more becomes a note in the report with a screenshot.
//            after: only when the last action was of that kind; streak: only once, when that many steps in a row agree
//   doneWhen: the "true" side of the done question; the runner ends the session after three steps at 0.8 or more
export const AGENTS = {
	explorer: {
		name: "Explorer", blurb: "Wanders, presses every button, uses every prompt. Finds crashes and dead ends.",
		goal: "Reach content the player has not seen yet and try everything once.",
		offers: { buttons: true, interactables: true, walks: true },
		notes: {},
		doneWhen: "Every button on screen and every nearby interactable has been tried and the last several walks reached nothing new.",
	},
	ui: {
		name: "UI tester", blurb: "Only the interface: opens every menu, presses every button, checks each one did something.",
		goal: "Press every button and open every menu; walk only to look for more interface.",
		offers: { buttons: true, interactables: false, walks: "explore" },
		notes: {
			deadButton: { kind: "dead-button", after: "click", instructions: "The last click changed nothing.",
				criteria: { true: "The last action was a click and the buttons on screen, the leaderstats and the console are the same as before it.", false: "The last action was not a click, or something on screen, the stats or the console changed after it." },
				text: (last) => `"${last?.text ?? "the button"}" did nothing when clicked` },
		},
		doneWhen: "Every button that has been on screen has been clicked at least once and no new button has appeared for several steps.",
	},
	breaker: {
		name: "Breaker", blurb: "Tries to cheat: spams prompts, runs at edges, buys with nothing. Watches for stats that change without cause.",
		goal: "Break the rules: use the same prompt or button again and again, run into walls and off edges, press buy or claim repeatedly, and look for money, health or stats that change without a cause.",
		offers: { buttons: true, interactables: true, walks: true, repeat: true, spam: true },
		notes: {
			exploit: { kind: "exploit", instructions: "Health, money or a stat changed without an action that should change it.",
				criteria: { true: "The leaderstats or health differ from the step before while the last actions were only walks, jumps or repeated uses that should not grant anything, or a stat went negative or jumped by far more than one use gives.", false: "Stats and health are unchanged, or changed by an action that is meant to change them." },
				text: (last, s) => `stats changed without a cause after ${last ? last.kind : "nothing"}: ${JSON.stringify(s.server?.leaderstats ?? {})}` },
		},
		doneWhen: "Each prompt and button has been used repeatedly, the edges have been run at, and nothing suspicious has happened for several steps.",
	},
	newbie: {
		name: "Newbie", blurb: "A first-time player with no help. Reports where they would not know what to do next.",
		goal: "Play as someone who has never seen this game: do what the screen suggests and nothing more.",
		offers: { buttons: true, interactables: true, walks: true },
		notes: {
			lost: { kind: "confusing", streak: 3, instructions: "A first-time player would not know what to do next from what is on screen.",
				criteria: { true: "No button, prompt or console line says what to do, and the last actions were aimless walks that reached nothing.", false: "A button, a prompt, a nearby interactable or a message makes the next step obvious." },
				text: () => "a first-time player would not know what to do here" },
		},
		doneWhen: "The player has found the game's first clear objective and started on it, or has run out of things the screen suggests.",
	},
};
export default AGENTS;
