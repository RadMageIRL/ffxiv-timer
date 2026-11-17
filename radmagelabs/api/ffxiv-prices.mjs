// Live market prices for FFXIV Timer at radmagelabs.com/ffxiv/prices/... (vercel.json rewrites
// those paths here, see ../vercel.prices.json). This function asks Universalis itself, so the
// visitor's browser only ever talks to radmagelabs.com and Universalis never sees the visitor.
// Everything is in _ffxiv-prices/handler.mjs; this file is the copy radmagelabs.com deploys.
import { createPricesHandler } from './_ffxiv-prices/handler.mjs';

export default createPricesHandler();
