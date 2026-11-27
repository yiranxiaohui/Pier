# Pier 图标

统一的矢量源文件为 `assets/brand/pier.svg`。标志是一个有厚度的立体 P：实心的字面上凹刻着青色 `>`，对应编码 Agent 与终端；P 脚边的青色光标块对应等待输入的提示符。P 与光标块都向右下方挤出 47 个单位形成侧壁，光从上方照来，朝右的侧壁较亮、朝下的较暗；底板是青到蓝再到靛的渐变，标志在底板上投下一层柔和的阴影。

![Pier 图标、平台裁切与小尺寸预览](branding-preview.png)

源文件里，`defs` 中的 `p-face`、`cursor-face` 是正面轮廓，`p-side`、`cursor-side` 是对应的侧壁，即正面轮廓朝右下方平移 47 个单位扫过的区域；`prompt` 是凹刻的提示符，同一形状再深 13 个单位就是它的底面。`ink-lit`、`signal-lit` 两个渐变垂直于挤出方向，叠在侧壁的暗色上表现受光，侧壁上每一点的明暗都取自它对应的那段轮廓的朝向。阴影（`shade` 分组）是整个标志叠加若干层逐渐加宽、变淡的描边，不使用模糊滤镜，因此 CairoSVG 与浏览器渲染出的效果一致。改动正面轮廓时要同步重算侧壁路径与两个 `*-lit` 渐变；`apps/desktop/public/favicon.svg` 与桌面端 `components/Icons.tsx` 的 `Logo` 组件各有一份同样的路径，也要一起更新。

桌面应用图标直接使用 `pier.svg` 原图（蓝色底板、白色立体 P），按 Apple 1024px 画布上的 824px 网格做成连续圆角底板。手机图标与浏览器 favicon 与桌面端应用内的标志一致：只取 `mark` 分组、不带底板，并换成浅色主题的 `--logo-*` 配色（蓝色 P、深蓝侧壁、青色提示符与光标）；深色主题下应用内的标志沿用原图的白色 P。浏览器 favicon 是透明底、不带阴影、按应用内标志裁切的标志本身；iOS 图标不能带透明通道，标志连同阴影放在白底满版图上，手机启动页是同一张图的连续圆角版本。Android 自适应图标以白色为背景、标志为前景，生成前景时整体缩放到 82%，使标志的实心部分保持在 Android 的中央 66/108 圆形安全区域内（只有阴影最淡的边缘会超出），适配圆形、圆角矩形等系统蒙版。Android 主题图标是同样缩放的白色单色标志：系统只按透明度着色，所以正面不透明、侧壁半透明，提示符镂空。

修改 SVG 后，在仓库根目录重新生成图片（Python 依赖 Pillow 与 CairoSVG，可通过 uv 临时提供；系统需安装 Cairo 运行库）：

```bash
uv run --with pillow --with cairosvg python apps/desktop/scripts/make-app-icon.py
cd apps/desktop
bun run tauri icon src-tauri/app-icon.png --output src-tauri/icons
```

Tauri CLI 还会生成 `icons/android` 与 `icons/ios`；手机端由 Expo 使用 `apps/mobile/assets` 中的图片，因此这两个生成目录不需要提交。修改完成后检查 16px / 32px 的可读性、浅深背景，以及 Android 圆形与圆角方形裁切。
