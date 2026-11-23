/**
 * Android UA carries the device model before `Build/` or `;`:
 * `Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A.240205.004) ...`
 * iOS Safari UAs only report "iPhone"/"iPad", never the hardware model.
 */
const ANDROID_MODEL = /Android [^;]+;\s*([^;)]+?)(?:\s+Build[/;]|[;)])/;

function detectOs(ua: string): string {
	if (/\b(?:iPhone|iPad|iPod)\b/i.test(ua)) return "iOS";
	if (/\bAndroid\b/i.test(ua)) return "Android";
	if (/\bWindows\b/i.test(ua)) return "Windows";
	if (/\b(?:Mac OS X|Macintosh)\b/i.test(ua)) return "macOS";
	if (/\bCrOS\b/i.test(ua)) return "Chrome OS";
	if (/\bLinux\b/i.test(ua)) return "Linux";
	return "";
}

function detectBrowser(ua: string): string {
	if (/\b(?:Edg|EdgA|EdgiOS)\//i.test(ua)) return "Microsoft Edge";
	if (/\b(?:OPR|Opera)\//i.test(ua)) return "Opera";
	if (/\b(?:Firefox|FxiOS)\//i.test(ua)) return "Firefox";
	if (/\b(?:Chrome|CriOS)\//i.test(ua)) return "Chrome";
	if (/\bSafari\//i.test(ua)) return "Safari";
	return "";
}

/**
 * Compresses a browser user-agent string into a readable device label such as
 * `Pixel 8 · Chrome`, `iOS · Safari`, or `Windows · Microsoft Edge`.
 */
export function describeDevice(userAgent: string): string {
	const ua = userAgent.trim();
	if (!ua) return "";
	const model = ANDROID_MODEL.exec(ua)?.[1]?.trim();
	const label = model || detectOs(ua);
	const browser = detectBrowser(ua);
	const name = [label, browser].filter(Boolean).join(" · ");
	return name || ua.slice(0, 80);
}
