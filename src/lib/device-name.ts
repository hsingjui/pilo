import Bowser from "bowser";

/**
 * Android UA 里唯一带机型的位置:
 * `Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A.240205.004) ...`
 * iOS 的 UA 永远只写 "iPhone",拿不到机型——这是平台限制。
 */
const ANDROID_MODEL = /Android [^;]+;\s*([^;)]+?)(?:\s+Build[/;]|[;)])/;

/**
 * 把原始 UA 压成可读的设备名,例如 `Pixel 8 · Chrome`、`iOS · Safari`、
 * `Windows · Chrome`。用于配对时上报 deviceName,让「已认证设备」列表可识别。
 */
export function describeDevice(userAgent: string): string {
	const ua = userAgent.trim();
	if (!ua) return "";
	const parser = Bowser.getParser(ua);
	const model = ANDROID_MODEL.exec(ua)?.[1]?.trim();
	const label = model || parser.getOSName() || parser.getPlatformType();
	const name = [label, parser.getBrowserName()].filter(Boolean).join(" · ");
	return name || ua.slice(0, 80);
}
