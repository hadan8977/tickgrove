# Tickgrove identity

**Tickgrove** — An extensible trading workspace.

The mark combines three candlesticks with a shared root. Their uneven crowns suggest a grove; the connection represents a common foundation for data, strategies, and extensions. It works in one color without a gradient, growth arrow, or enclosing letter.

![Tickgrove identity](images/tickgrove-brand.png)

## Assets

- [Forest mark](../public/brand/tickgrove-mark.svg)
- [Monochrome mark](../public/brand/tickgrove-mark-mono.svg)
- [Inverse mark](../public/brand/tickgrove-mark-inverse.svg)
- [App icon](../public/brand/tickgrove-icon.svg)
- [Avatar PNG](../public/brand/tickgrove-avatar.png)
- [Social preview PNG](../public/brand/tickgrove-social.png)
- [Light lockup](../public/brand/tickgrove-lockup-light.svg)
- [Dark lockup](../public/brand/tickgrove-lockup-dark.svg)
- [Outlined wordmark](../public/brand/tickgrove-wordmark.svg)

Standalone colors are forest `#236449`, deep forest `#163F30`, and mint `#9DE2B6`. In the application, the mark uses the light/dark brand token while text follows the active theme. Keep at least one-quarter of the mark's width clear around standalone artwork. The mark is intended to remain legible at 16 px; use the full wordmark when space permits.

The React mark and exported SVGs share [mark.json](../src/brand/mark.json). Run `npm run brand:generate` after editing it. The standalone wordmark contains outlined Geist SemiBold glyphs, so exported SVGs do not depend on an installed font. Its geometry and source are recorded in [wordmark.json](../src/brand/wordmark.json); the font's [OFL license](../public/fonts/geist-OFL.txt) is retained. The application uses the bundled Geist font for live text.

Product name: `Tickgrove`. Repository and executable prefix: `tickgrove`. Use ordinary capitalization in prose and lowercase in technical identifiers. The name identifies the workspace across markets, data providers, and strategy runtimes.

Historical reports and upstream attributions keep their original names. Legacy protocol IDs, storage formats, and command aliases are compatibility contracts; they are not new product names. See the [upgrade notes](self-hosting.md#upgrading-from-trading-dashboard).
