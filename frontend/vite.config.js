import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, loadEnv } from 'vite';

/**
 * lucide-svelte draws every icon child as `<svelte:element this={tag} {...attrs}/>`.
 * Neither the tag nor the attribute names are statically known, so Svelte 4 emits a
 * hydration claim with an empty known-attribute map. `claim_element_base` then strips
 * every attribute off the server-rendered node before re-applying it, and Safari logs
 * the transient empty value for each one ("Invalid value for <line> attribute y2=''").
 *
 * Naming the attributes explicitly puts them in the claim map so they survive hydration.
 * The spread is kept so nothing is dropped if lucide ever emits a key not listed here;
 * `?? defaultAttributes` preserves the original $$restProps override order on <svg>.
 *
 * Attribute surface verified against all icons in lucide-svelte@0.460.1:
 * tags path/circle/rect/line/polyline/polygon/ellipse, keys d, cx, cy, r, x, y, width,
 * height, rx, ry, points, x1, x2, y1, y2, fill.
 */
function lucideHydrationAttrs() {
	const target = 'lucide-svelte/dist/Icon.svelte';

	const edits = [
		[
			'  {...$$restProps}\n',
			// NB: do not add `xmlns` here. Svelte derives an element's namespace from a
			// *static* xmlns attribute; a dynamic one voids it and the whole icon subtree
			// gets compiled as HTML elements instead of SVG, so nothing renders.
			'  {...$$restProps}\n' +
				'  viewBox={$$restProps.viewBox ?? defaultAttributes.viewBox}\n' +
				'  fill={$$restProps.fill ?? defaultAttributes.fill}\n' +
				"  stroke-linecap={$$restProps['stroke-linecap'] ?? defaultAttributes['stroke-linecap']}\n" +
				"  stroke-linejoin={$$restProps['stroke-linejoin'] ?? defaultAttributes['stroke-linejoin']}\n"
		],
		[
			'<svelte:element this={tag} {...attrs}/>',
			'<svelte:element this={tag} {...attrs}\n' +
				'      d={attrs.d}\n' +
				'      cx={attrs.cx} cy={attrs.cy} r={attrs.r}\n' +
				'      x={attrs.x} y={attrs.y} width={attrs.width} height={attrs.height}\n' +
				'      rx={attrs.rx} ry={attrs.ry}\n' +
				'      points={attrs.points}\n' +
				'      x1={attrs.x1} x2={attrs.x2} y1={attrs.y1} y2={attrs.y2}\n' +
				'      fill={attrs.fill}/>'
		]
	];

	return {
		name: 'lucide-hydration-attrs',
		enforce: 'pre',
		transform(code, id) {
			if (!id.split('?')[0].endsWith(target)) return null;

			let out = code;
			for (const [from, to] of edits) {
				if (!out.includes(from)) {
					this.warn(
						`lucide-hydration-attrs: pattern not found in ${target}, leaving it untouched. ` +
							`Did lucide-svelte change? Re-check the patch or drop this plugin.`
					);
					return null;
				}
				// Replacer function, not a string: `$$` in a replacement string is an
				// escape for a literal `$`, which would turn `$$restProps` into
				// `$restProps` and make Svelte treat it as a store subscription.
				out = out.replace(from, () => to);
			}
			return { code: out, map: null };
		}
	};
}

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '');
    const isDevBuild = env.BUILD_MODE === 'development';

    return {
        plugins: [lucideHydrationAttrs(), sveltekit()],
        build: {
            minify: 'terser',
            terserOptions: {
                mangle: !isDevBuild, // Only mangle in production
                compress: {
                    keep_fnames: isDevBuild, // Keep function names in development
                    keep_classnames: isDevBuild // Keep class names in development
                },
                format: {
                    comments: false
                }
            }
        }
    };
});
