import type { BrowserPreparationProgress } from "@pier/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrowserPreparationStatus } from "../src/components/BrowserPreparationStatus.tsx";

const render = (progress: BrowserPreparationProgress, running = true) =>
	renderToStaticMarkup(createElement(BrowserPreparationStatus, { progress, running, onCancel() {} }));

describe("browser preparation details", () => {
	it("shows live output as text without inventing an installation percentage", () => {
		const html = render({
			stage: "installing",
			message: "正在安装系统依赖",
			logs: "Unpacking xvfb\n<script>unsafe</script>",
		});
		expect(html).toContain("正在安装系统依赖");
		expect(html).toContain("安装日志（最近输出）");
		expect(html).toContain("Unpacking xvfb");
		expect(html).toContain("&lt;script&gt;unsafe&lt;/script&gt;");
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<progress");
		expect(html).toContain("取消准备");
	});
	it("shows known download sizes and an indeterminate bar for unknown sizes", () => {
		const html = render({
			stage: "downloading",
			message: "下载浏览器",
			downloadedBytes: 1024,
			totalBytes: 4096,
			logs: "",
		});
		expect(html).toContain("25%");
		expect(html).toContain('value="25"');
		expect(html).toContain("已下载");
		expect(render({ stage: "downloading", message: "下载浏览器", downloadedBytes: 1024 })).not.toContain("value=");
	});
	it("keeps failure output readable without a spinner or cancel action", () => {
		const html = render({ stage: "installing", message: "安装中", logs: "E: disk full" }, false);
		expect(html).toContain("最后一次安装输出");
		expect(html).toContain("E: disk full");
		expect(html).not.toContain("取消准备");
		expect(html).not.toContain("spin");
	});
	it("explains missing log support on older hosts", () => {
		expect(render({ stage: "installing", message: "安装中" })).toContain("更新本机和远程主机");
	});
});
