# Webflow Slider

Drag / swipe / arrow / trackpad slider for Webflow, built for Collection Lists. Many sliders per page are supported.

## Install

Paste into **Site settings → Custom code → Footer code** (or a page's *Before `</body>` tag*):

```html
<script src="https://cdn.jsdelivr.net/gh/Furnesdesign/webflow-slider@1/slider.min.js"></script>
```

## Versions

Releases are git tags using semantic versioning (`v1.0.0`, `v1.0.1`, `v1.1.0`, `v2.0.0` …).

| Link | Gets |
| --- | --- |
| `@1` | Newest 1.x.x — bug fixes and new features, never breaking changes. **Use this on sites.** |
| `@1.0.0` | Exactly that version, never changes. |
| `@main` | Latest commit. For testing only – never on live sites. |

- **Patch** (`1.0.1`): bug fix. **Minor** (`1.1.0`): new optional feature. Both reach every `@1` site automatically.
- **Major** (`2.0.0`): renamed attributes or changed behaviour. Sites stay on `@1` until you change their link.
- jsDelivr caches `@1` for a while. To roll out a release right away, open
  `https://purge.jsdelivr.net/gh/Furnesdesign/webflow-slider@1/slider.min.js` (and `slider.js`).
- Check which version a site runs: type `FurnesSlider.version` in the browser console.

### Releasing a new version

1. Update the version in the header comment and in `window.FurnesSlider = { version: ... }` in `slider.js`.
2. Commit and push.
3. Tag and push the tag:
   ```
   git tag v1.0.1
   git push origin v1.0.1
   ```

## Attributes

| Element | Attribute |
| --- | --- |
| Wrapper (around list and arrows) | `slider="wrapper"` |
| List – the visible area (usually the Collection List) | `slider="list"` |
| Each slide (usually the Collection Item) | `slider="item"` |
| Previous arrow (optional) | `slider-nav="left"` |
| Next arrow (optional) | `slider-nav="right"` |

The last slide stops at the **right edge of the list**, so there are no empty slots at the end.
Add `slider-end="item"` on the wrapper to scroll until the last slide is at the left edge instead.

Put `overflow: hidden` on a parent (e.g. the section) if the slides that stick out to the right should be cut off at the page edge.

## Styling hooks set by the script

| Selector | When |
| --- | --- |
| `[slider-nav][data-slider-disabled="true"]` | Arrow has nowhere to go (faded by default) |
| `[slider="wrapper"][data-slider-static="true"]` | All slides fit – e.g. hide the arrows |
| `[slider="list"][data-slider-dragging="true"]` | While dragging |

## JavaScript API

```js
FurnesSlider.version;              // "1.0.0"
FurnesSlider.init();               // set up sliders added after page load
FurnesSlider.instances[0].next();  // also: prev(), goTo(index), refresh()
```
