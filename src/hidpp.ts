import { EventEmitter } from 'node:events'
import type { HIDAsync } from 'node-hid'

/**
 * Minimal HID++ 2.0 client for one Bluetooth-connected Logitech device.
 *
 * Requests are long reports (0x11, 20 bytes) to device index 0xFF, sent one at a
 * time. Replies carry our software id in the low nibble of byte 3; anything else
 * that arrives is a notification from the device and is emitted as 'event'.
 */

const LONG_REPORT = 0x11
const SHORT_REPORT = 0x10
const DEVICE_INDEX = 0xff
const SOFTWARE_ID = 0x0a
const ERROR_FEATURE = 0xff
const TIMEOUT_MS = 2000

export const FEATURE_ROOT = 0x0000
export const FEATURE_REPROG_CONTROLS_V4 = 0x1b04
export const FEATURE_WIRELESS_STATUS = 0x1d4b
export const FEATURE_DIAL_ROLLER = 0x4610 // undocumented: the Dialpad's dial and roller

interface PendingRequest {
	featureIndex: number
	functionByte: number
	resolve: (params: Buffer) => void
	reject: (err: Error) => void
	timer: ReturnType<typeof setTimeout>
}

export interface HidppEvents {
	event: [report: Buffer]
	error: [err: Error]
}

export class Hidpp extends EventEmitter<HidppEvents> {
	readonly #device: HIDAsync
	#pending: PendingRequest | null = null
	#queue: Promise<unknown> = Promise.resolve()
	#closed = false

	constructor(device: HIDAsync) {
		super()
		this.#device = device
		this.#device.on('data', (data: Buffer) => this.#onData(data))
		this.#device.on('error', (err: Error) => {
			this.#failPending(err)
			if (this.listenerCount('error') > 0) this.emit('error', err)
		})
	}

	#onData(data: Buffer): void {
		if (data.length < 5) return
		if (data[0] !== LONG_REPORT && data[0] !== SHORT_REPORT) return
		if (data[1] !== DEVICE_INDEX) return

		const pending = this.#pending
		if (data[2] === ERROR_FEATURE) {
			if (pending && data[3] === pending.featureIndex && data[4] === pending.functionByte) {
				this.#settle()
				pending.reject(new Error(`HID++ error ${data[5]} on feature index ${data[3]}`))
			}
			return
		}
		if ((data[3] & 0x0f) === SOFTWARE_ID) {
			if (pending && data[2] === pending.featureIndex && data[3] === pending.functionByte) {
				this.#settle()
				pending.resolve(Buffer.from(data.subarray(4)))
			}
			return
		}
		this.emit('event', data)
	}

	#settle(): void {
		if (this.#pending) clearTimeout(this.#pending.timer)
		this.#pending = null
	}

	#failPending(err: Error): void {
		const pending = this.#pending
		if (!pending) return
		this.#settle()
		pending.reject(err)
	}

	/** Call a function of a feature (by its index on this device). Resolves with the reply's parameter bytes. */
	async call(featureIndex: number, func: number, params: number[] = []): Promise<Buffer> {
		const run = async (): Promise<Buffer> => {
			if (this.#closed) throw new Error('Device closed')
			const functionByte = ((func & 0x0f) << 4) | SOFTWARE_ID
			const msg = Buffer.alloc(20)
			msg[0] = LONG_REPORT
			msg[1] = DEVICE_INDEX
			msg[2] = featureIndex
			msg[3] = functionByte
			params.slice(0, 16).forEach((v, i) => (msg[4 + i] = v & 0xff))

			return new Promise<Buffer>((resolve, reject) => {
				this.#pending = {
					featureIndex,
					functionByte,
					resolve,
					reject,
					timer: setTimeout(() => this.#failPending(new Error('No reply from the Dialpad')), TIMEOUT_MS),
				}
				this.#device.write(msg).catch((e: unknown) => this.#failPending(e instanceof Error ? e : new Error(String(e))))
			})
		}
		const result = this.#queue.then(run, run)
		this.#queue = result.catch(() => undefined)
		return result
	}

	/** Where a feature lives on this device, or null if it doesn't have it. */
	async featureIndex(featureId: number): Promise<number | null> {
		const r = await this.call(0x00, 0, [featureId >> 8, featureId & 0xff])
		return r[0] === 0 && featureId !== FEATURE_ROOT ? null : r[0]
	}

	async close(): Promise<void> {
		this.#closed = true
		this.#failPending(new Error('Device closed'))
		await this.#device.close()
	}
}
