import {
	createModuleLogger,
	type DiscoveredSurfaceInfo,
	type HIDDevice,
	type OpenSurfaceResult,
	type SurfaceContext,
	type SurfacePlugin,
} from '@companion-surface/base'
import { HIDAsync } from 'node-hid'
import {
	Hidpp,
	FEATURE_DIAL_ROLLER,
	FEATURE_REPROG_CONTROLS_V4,
	FEATURE_WIRELESS_STATUS,
} from './hidpp.js'
import { MxDialpadSurface, createLayout } from './instance.js'

const logger = createModuleLogger('Plugin')

const LOGITECH = 0x046d
const MX_DIALPAD_BLUETOOTH = 0xbc00
const HIDPP_USAGE_PAGE = 0xff43 // Logitech's own channel; the mouse channel is kept by the OS

const MxDialpadPlugin: SurfacePlugin<HIDDevice> = {
	init: async (): Promise<void> => {
		// Nothing to do
	},
	destroy: async (): Promise<void> => {
		// Nothing to do
	},

	checkSupportsHidDevice: (device: HIDDevice): DiscoveredSurfaceInfo<HIDDevice> | null => {
		if (device.vendorId !== LOGITECH || device.productId !== MX_DIALPAD_BLUETOOTH) return null
		// The Dialpad shows up as several HID collections; only Logitech's own one is usable
		if (device.usagePage !== undefined && device.usagePage !== HIDPP_USAGE_PAGE) return null

		return {
			surfaceId: `mx-dialpad:${device.serialNumber || 'dialpad'}`,
			description: 'Logitech MX Creative Dialpad',
			pluginInfo: device,
		}
	},

	openSurface: async (surfaceId: string, pluginInfo: HIDDevice, context: SurfaceContext): Promise<OpenSurfaceResult> => {
		logger.debug(`Opening ${pluginInfo.product} (${surfaceId})`)
		const hidpp = new Hidpp(await HIDAsync.open(pluginInfo.path))
		try {
			const reprogControls = await hidpp.featureIndex(FEATURE_REPROG_CONTROLS_V4)
			const dialRoller = await hidpp.featureIndex(FEATURE_DIAL_ROLLER)
			const wirelessStatus = await hidpp.featureIndex(FEATURE_WIRELESS_STATUS)
			if (reprogControls === null || dialRoller === null) {
				throw new Error("This Dialpad's firmware is missing a feature I need, so I can't use it")
			}

			return {
				surface: new MxDialpadSurface(surfaceId, hidpp, { reprogControls, dialRoller, wirelessStatus }, context),
				registerProps: {
					brightness: false,
					surfaceLayout: createLayout(),
					pincodeMap: null,
					location: null,
					configFields: [
						{
							id: 'reverseDial',
							type: 'checkbox',
							label: 'Reverse dial direction',
							tooltip: 'Normally clockwise is rotate right. Tick this to swap it round.',
							default: false,
						},
						{
							id: 'reverseRoller',
							type: 'checkbox',
							label: 'Reverse roller direction',
							tooltip: 'Normally rolling up (away from you) is rotate right. Tick this to swap it round.',
							default: false,
						},
						{
							id: 'crew',
							type: 'static-text',
							label: "Psst. This one's got mates. 🍹",
							value:
								"MX Creative Dialpad is part of a little crew of Companion modules: some brand new, some old favourites given a good tweak. Want to know who else is in the crew, or grab the freshest version of each one? It's all here: " +
								'https://github.com/nisted/companion-modules',
						},
					],
				},
			}
		} catch (e) {
			await hidpp.close().catch(() => undefined)
			throw e
		}
	},
}
export default MxDialpadPlugin
