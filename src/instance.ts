import {
	type CardGenerator,
	type ModuleLogger,
	type SurfaceContext,
	type SurfaceDrawProps,
	type SurfaceInstance,
	type SurfaceSchemaLayoutDefinition,
	createModuleLogger,
} from '@companion-surface/base'
import { Hidpp } from './hidpp.js'

/** Controls as they appear in Companion (row/column), laid out like the Dialpad itself. */
export const ROLLER_ID = '0/2'
export const DIAL_ID = '1/1'
const BUTTON_IDS = new Map<number, string>([
	[0x0053, '0/0'], // top row, first button
	[0x0056, '0/1'], // top row, second button
	[0x0059, '1/0'], // bottom-left
	[0x005a, '1/2'], // bottom-right
])

/** Dial/roller feature: control numbers and the mode that sends them to us. */
const ROLLER_CONTROL = 0
const DIAL_CONTROL = 1
const MODE_REPORT_TO_HOST = 1

/** How often to check the Dialpad is still sending to us (it forgets after sleep or reconnecting). */
const CHECK_EVERY_MS = 15_000

export function createLayout(): SurfaceSchemaLayoutDefinition {
	const layout: SurfaceSchemaLayoutDefinition = {
		stylePresets: { default: {} }, // nothing to draw: no displays or lights
		controls: {},
	}
	for (const id of [DIAL_ID, ROLLER_ID, ...BUTTON_IDS.values()]) {
		const [row, column] = id.split('/').map(Number)
		layout.controls[id] = { row, column }
	}
	return layout
}

export interface FeatureIndexes {
	reprogControls: number
	dialRoller: number
	wirelessStatus: number | null
}

export class MxDialpadSurface implements SurfaceInstance {
	readonly #logger: ModuleLogger
	readonly #surfaceId: string
	readonly #context: SurfaceContext
	readonly #hidpp: Hidpp
	readonly #features: FeatureIndexes

	#held = new Set<number>()
	#reverseDial = false
	#reverseRoller = false
	#checkTimer: ReturnType<typeof setInterval> | undefined
	#retakeTimer: ReturnType<typeof setTimeout> | undefined
	#closed = false

	public get surfaceId(): string {
		return this.#surfaceId
	}
	public get productName(): string {
		return 'MX Creative Dialpad'
	}

	constructor(surfaceId: string, hidpp: Hidpp, features: FeatureIndexes, context: SurfaceContext) {
		this.#logger = createModuleLogger(`Instance/${surfaceId}`)
		this.#surfaceId = surfaceId
		this.#hidpp = hidpp
		this.#features = features
		this.#context = context

		this.#hidpp.on('event', (report) => this.#onEvent(report))
		this.#hidpp.on('error', (err) => {
			this.#logger.error(`Dialpad error: ${err.message}`)
			this.#releaseAll()
			this.#context.disconnect(err)
		})
	}

	/** Ask the Dialpad to send its buttons, dial and roller to us instead of to the computer as a mouse. */
	async #takeOver(): Promise<void> {
		for (const cid of BUTTON_IDS.keys()) {
			// setCidReporting: divert (0x01) + divert valid (0x02), no remap
			await this.#hidpp.call(this.#features.reprogControls, 3, [cid >> 8, cid & 0xff, 0x03, 0x00, 0x00])
		}
		for (const control of [ROLLER_CONTROL, DIAL_CONTROL]) {
			await this.#hidpp.call(this.#features.dialRoller, 3, [control, MODE_REPORT_TO_HOST])
		}
		this.#logger.info('Dialpad controls now report to Companion')
	}

	/** Put the Dialpad back to normal (best effort, used when Companion lets go of it). */
	async #giveBack(): Promise<void> {
		for (const cid of BUTTON_IDS.keys()) {
			await this.#hidpp.call(this.#features.reprogControls, 3, [cid >> 8, cid & 0xff, 0x02, 0x00, 0x00])
		}
		for (const control of [ROLLER_CONTROL, DIAL_CONTROL]) {
			await this.#hidpp.call(this.#features.dialRoller, 3, [control, 0])
		}
	}

	async #checkStillOurs(): Promise<void> {
		try {
			const r = await this.#hidpp.call(this.#features.dialRoller, 2, [DIAL_CONTROL])
			if (r[0] !== MODE_REPORT_TO_HOST) {
				this.#logger.info('Dialpad had reset its settings; taking it over again')
				await this.#takeOver()
			}
		} catch (e) {
			this.#logger.debug(`Check failed (Dialpad asleep?): ${e instanceof Error ? e.message : e}`)
		}
	}

	#scheduleRetake(): void {
		if (this.#retakeTimer || this.#closed) return
		this.#retakeTimer = setTimeout(() => {
			this.#retakeTimer = undefined
			this.#takeOver().catch((e) => this.#logger.warn(`Couldn't take the Dialpad over again: ${e}`))
		}, 500)
	}

	#onEvent(report: Buffer): void {
		const featureIndex = report[2]
		const eventNumber = report[3] >> 4

		if (featureIndex === this.#features.reprogControls && eventNumber === 0) {
			// The buttons held right now, as up to 4 two-byte control ids
			const now = new Set<number>()
			for (let i = 4; i + 1 < 12 && i + 1 < report.length; i += 2) {
				const cid = (report[i] << 8) | report[i + 1]
				if (cid) now.add(cid)
			}
			for (const cid of now) {
				if (!this.#held.has(cid)) {
					const id = BUTTON_IDS.get(cid)
					if (id) this.#context.keyDownById(id)
				}
			}
			for (const cid of this.#held) {
				if (!now.has(cid)) {
					const id = BUTTON_IDS.get(cid)
					if (id) this.#context.keyUpById(id)
				}
			}
			this.#held = now
			return
		}

		if (featureIndex === this.#features.dialRoller && eventNumber === 0) {
			const control = report[4]
			const delta = (report[5] << 24) >> 24 // signed byte
			if (!delta) return
			const isDial = control === DIAL_CONTROL
			const id = isDial ? DIAL_ID : control === ROLLER_CONTROL ? ROLLER_ID : null
			if (!id) return
			const reverse = isDial ? this.#reverseDial : this.#reverseRoller
			const right = delta > 0 !== reverse
			for (let i = 0; i < Math.abs(delta); i++) {
				if (right) this.#context.rotateRightById(id)
				else this.#context.rotateLeftById(id)
			}
			return
		}

		if (this.#features.wirelessStatus !== null && featureIndex === this.#features.wirelessStatus) {
			// The Dialpad has (re)connected and may have forgotten our settings
			this.#releaseAll()
			this.#scheduleRetake()
		}
	}

	#releaseAll(): void {
		for (const cid of this.#held) {
			const id = BUTTON_IDS.get(cid)
			if (id) this.#context.keyUpById(id)
		}
		this.#held.clear()
	}

	async init(): Promise<void> {
		await this.#takeOver()
		this.#checkTimer = setInterval(() => void this.#checkStillOurs(), CHECK_EVERY_MS)
	}

	async updateConfig(config: Record<string, any>): Promise<void> {
		this.#reverseDial = !!config.reverseDial
		this.#reverseRoller = !!config.reverseRoller
	}

	async ready(): Promise<void> {
		// Nothing to do
	}

	async close(): Promise<void> {
		this.#closed = true
		if (this.#checkTimer) clearInterval(this.#checkTimer)
		if (this.#retakeTimer) clearTimeout(this.#retakeTimer)
		this.#releaseAll()
		try {
			await this.#giveBack()
		} catch {
			// Dialpad already gone: it resets itself when it next connects
		}
		await this.#hidpp.close().catch((e) => this.#logger.error(`Failed to close the Dialpad: ${e}`))
	}

	async setBrightness(_percent: number): Promise<void> {
		// No displays or lights
	}
	async blank(): Promise<void> {
		// No displays or lights
	}
	async draw(_signal: AbortSignal, _drawProps: SurfaceDrawProps): Promise<void> {
		// No displays or lights
	}
	async showStatus(_signal: AbortSignal, _cardGenerator: CardGenerator, _statusMessage: string): Promise<void> {
		// No displays or lights
	}
}
