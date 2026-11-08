# Wowhead as a WoW Forever source

> Follow-up: the broader provider investigation below supersedes the initial recommendation to start with search. Direct Forever API providers should be evaluated first.

Investigated 2026-11-07. Research only; no bot behaviour changed.

## Decision

Wowhead is useful for Forever lookups, especially resolving a known item ID into current tooltip details. It is not yet a verified, complete backend for discovery and loot queries. Use a small Wowhead adapter alongside a search provider, with explicit evidence and unavailable results. Do not build a bulk scraper as the first implementation.

The strongest result: direct HTTP requests to the tooltip service succeeded, and a controlled Classic/Forever comparison returned different values for the same item. Full database pages returned HTTP 403 from this machine.

## What was actually tested

These were ordinary Python 3 urllib requests without browser cookies, authentication, proxies, or challenge bypass. Results are point-in-time observations, not an uptime guarantee.

- `https://www.wowhead.com/forever/item=5191`: 403.
- `https://www.wowhead.com/forever/npc=639`: 403.
- `https://www.wowhead.com/forever/item=5191&xml`: 403. The historical XML approach was not usable here; this does not establish that XML has been removed everywhere.
- `https://wow.zamimg.com/js/tooltips.js`: 200, JavaScript. Its environment definitions map `CLASSICPLUS` to `16`, and its URL mapping calls that environment `forever`. The request builder appends `dataEnv` and `locale`.
- `https://nether.wowhead.com/tooltip/item/5191?dataEnv=16&locale=0`: 200, JSON. Cruel Barb, quality, icon, HTML tooltip, spells. Tooltip included damage, speed, DPS, required level, attack power, and “Dropped by: Edwin VanCleef” with 16.03%.
- `https://nether.wowhead.com/tooltip/npc/639?dataEnv=16&locale=0`: 200, JSON. Edwin VanCleef, title, level 21, elite humanoid, map zone 1581. Coordinates were empty. No loot list.
- `https://nether.wowhead.com/tooltip/spell/133?dataEnv=16&locale=0`: 200, JSON. Fireball, icon, HTML tooltip, buff information and additional fields.
- `https://nether.wowhead.com/tooltip/item/25?dataEnv=16&locale=0`: 200, JSON. Worn Shortsword. No drop source in the tooltip.
- `https://nether.wowhead.com/tooltip/item/999999999?dataEnv=16&locale=0`: 404.

The initial unqualified tooltip request also succeeded, but must not be used for Forever: always specify the environment.

### Proof that the environment changes the data

Item 5192, Thief's Blade, was requested with `dataEnv=4` (Classic) and `dataEnv=16` (Forever), both with locale 0.

Classic returned uncommon quality, 13–25 damage, 11.18 DPS and +3 agility. Forever returned rare quality, 17–32 damage, 14.41 DPS, +4 agility, a Pick Pocket/Distract effect, and Mr. Smite as its drop source with 37.58%.

This confirms that environment 16 produces distinct Forever data for this changed item. It does not establish coverage or freshness for every record. Drop percentages above are Wowhead's reported figures; their Forever sample provenance was not verified and they should not be presented as exact server probabilities.

## What Wowhead can supply

The [Forever database](https://www.wowhead.com/forever/database) and its linked pages expose items, NPCs, quests, spells, zones and other game entities. Bosses are represented by NPC records; dungeon/raid information also has journal and guide surfaces. Wowhead's [developer updates](https://www.wowhead.com/latest-dev-updates/RaefWolfe) describe Forever instance pages containing bosses and drop tables.

For bot purposes:

- **Exact item details:** verified through the tooltip endpoint. Stats remain mostly HTML inside JSON, so this is not a fully structured item API.
- **Who drops this item:** verified for two items through tooltip text. Treat it as an optional source summary, not a complete list of every acquisition method.
- **Exact NPC/boss details:** verified for one NPC. No loot table or useful coordinates in that tested response.
- **Name search and fuzzy matching:** search-engine discovery worked. A direct machine-readable Wowhead name-search API was not verified.
- **Filtered item discovery:** Wowhead exposes filters for required level, class, slot and other properties. Search results surfaced a filtered Forever weapons page containing item names and sources. Fetching that page returned the filter controls without its results, demonstrating that indexed content and live extraction can differ.
- **Full boss loot tables:** available on site surfaces according to Wowhead's updates, but reliable programmatic retrieval remains unproven.
- **Recommendations:** item records alone cannot establish “good for my character.” Combine class/spec, level, slot, intended activity and obtainable content with current Forever guides or an explicit ranking rule. Numeric DPS or item level alone is insufficient.
- **Comments:** useful leads, weak evidence. Forever item/NPC pages returned historical Thottbot/Allakhazam comments. Their presence under `/forever/` is not proof of Forever applicability.

## Access options and limits

### 1. Tooltip service: strongest starting point

Example:

```text
GET https://nether.wowhead.com/tooltip/item/5192?dataEnv=16&locale=0
GET https://nether.wowhead.com/tooltip/npc/639?dataEnv=16&locale=0
```

Wowhead publicly documents its [tooltip embedding feature](https://www.wowhead.com/tooltips). Its own [tooltip script](https://wow.zamimg.com/js/tooltips.js) provides the current endpoint construction. A [Wowhead staff forum response](https://www.wowhead.com/forums/topic/wowhead-tooltips-on-eqdkp-plus-site-329857) also identifies `nether.wowhead.com` as the tooltip host.

This is an externally used interface, but I did not find a documented general-purpose database API, service guarantee, published request quota, or grant for bulk ingestion. Embedding support does not itself establish permission for every reuse. Backend extraction and caching terms remain an open question for production use.

### 2. Search engine: discovery and fallback evidence

Queries scoped to `site:wowhead.com/forever/` found Cruel Barb, Edwin VanCleef, and filtered item listings. This can resolve names to IDs and locate guides without invoking Wowhead's own search endpoint.

Search is incomplete, may be stale, and may return other editions despite the intended scope. Validate the returned URL and entity type. Search snippets can provide attributed leads but cannot establish an exhaustive loot table. A search provider's ability to retrieve a page does not guarantee our bot can fetch it.

No commercial search/crawl provider was benchmarked. This investigation used the available web research tool, so provider choice, price, latency, extraction quality and Wowhead access still need a focused spike.

### 3. Full-page HTTP extraction: currently unreliable

Direct requests returned 403. Web research retrieval had mixed outcomes: an NPC page returned a JavaScript bot challenge; another item page returned its tooltip and many comments; listing pages could omit their data. A generic HTML-to-Markdown fetcher may discard embedded list data even when HTTP succeeds.

Browser rendering might expose more content, but was not tested and should not be assumed to solve access restrictions. Do not turn challenges into aggressive retries. A crawler service is only useful if a measured test shows it can retrieve the required Forever sections consistently under its access terms.

### 4. Crawling policy

Wowhead's current [robots.txt](https://www.wowhead.com/robots.txt) blocks several named AI crawlers and disallows search paths, including Forever search paths. This is a concrete constraint on a crawl-based design. It is not a conclusion about the legal terms of every endpoint; no legal review was performed. The tooltip host's separate crawling policy was not inspected.

## Alternative sources worth validating

- [Icy Veins Forever database](https://db.icy-veins.com/wow-forever/) explicitly offers item, spell, NPC and quest data. It also labels itself early access with missing pages. No API or full loot coverage verified.
- [ForeverDiff](https://foreverdiff.gg/) describes client-data comparisons plus player-collected quest, location and loot observations. Potentially useful for distinguishing changed records and missing evidence. No supported API verified.
- [Forever Codex sources](https://forever-codex.com/sources/) explicitly separates client DB2 data, server hotfixes, Classic baselines and external references. Its displayed source build was beta and its generation date October 8, so launch freshness must be checked before relying on it.
- Blizzard client data is a possible longer-term item/spell index. It requires an ingestion pipeline and cannot by itself answer all server-side loot questions. No Forever Battle.net API namespace or supported loot API was verified in this investigation.

These are candidates, not interchangeable verified fallbacks. Prefer a provider with an explicit usable interface over recreating several fragile scrapers.

## Suggested bot tools

Start with three small responsibilities:

1. `search_wow({query, kind})`: discover Forever item/NPC/guide candidates, returning IDs, titles, links and evidence excerpts. Keep search results distinguishable from verified record data.
2. `lookup_wow({kind, id})`: fetch a Forever tooltip and return bounded readable details, optional acquisition summary, source link and retrieval time.
3. `read_wow_source({url})`: retrieve a supported guide or database page when available; return an explicit unavailable result when blocked or when the required section is absent.

Only expose dedicated `get_boss_loot` / `find_items` filtering once the backend can supply their promised completeness. In the meantime, the bot can answer narrower questions from attributed evidence, while admitting when the full set is unknown.

For recommendation questions, the model uses search for relevant Forever guidance and lookup to verify candidate stats/acquisition. Ask for missing level/spec/slot only when it materially changes the answer.

The current bot already has a tool factory in `src/core/tools.ts`. Its four-step loop, six-call guard and 90-second deadline favour bounded combined search results and batched lookups. A long sequence of one tool per candidate will hit those limits. `src/prompt.ts` also currently says web access is unavailable and would need updating during implementation.

## Reliability requirements for implementation

- Fix the edition internally to Forever (`dataEnv=16`); never silently substitute Classic or Retail.
- Key caches by edition, entity kind, ID and locale. Include retrieval time and distinguish it from the source's build/update date.
- Validate JSON and requested entity identity, bound response size, sanitize tooltip HTML, and treat retrieved text as untrusted content.
- Preserve absent fields as unknown. A missing drop summary does not mean an item has no drops.
- Distinguish not-found, blocked, timeout and malformed response. Cache successes; use short negative caching and stop retrying access challenges.
- Preserve source links. Label recommendations and old comments separately from item facts.
- Treat a tooltip source summary as partial acquisition evidence and percentages as reported observations unless sample provenance is available.

## Next concrete step

Build a small retrieval spike before adding Discord tools: a fixed sample of unchanged, changed and new Forever items; bosses; ambiguous names; and absent records. Measure successful entity resolution, exact stat extraction, source extraction, full loot-table availability and request latency. Include a changed item such as Thief's Blade to detect edition mistakes.

The initial implementation can use search for discovery and the tooltip service for verification. The unresolved decision is the source for complete filtered item sets and boss loot tables; today's tests do not justify promising either from Wowhead alone.

## Broader provider investigation — 2026-11-07

### Revised recommendation

Evaluate ForeverDB for structured discovery, Everloot for observed sources/drops, and Blizzard's emerging Forever endpoints. Keep Wowhead as an independently useful lookup/reference source. Web search remains valuable for guides, ambiguous questions and missing records, but is not a prerequisite if a direct API meets our needs. None of the direct providers has yet passed an authenticated, end-to-end correctness evaluation from our deployment environment.

Research covered official developer documentation, publisher source descriptions, GitHub repositories/issues, Blizzard developer forum reports, Reddit feedback and rating sites. This was broad discovery and a small set of read-only HTTP checks, not an exhaustive correctness audit or a production uptime test. No accounts, keys, paid services or software installations were created.

### ForeverDB.net — closest advertised match

[Developer documentation](https://foreverdb.net/developers) describes item name search and filters for quality, class, slot and required level, detailed items, spells, quests, vendors and dungeon details with bosses and notable loot. Requires Battle.net sign-in and developer approval before creating keys. Documented limits: 60 requests/minute and 10,000/day. Visible attribution required; resale prohibited. No monetary price was established. Responses document build metadata and uncertainty markers. No general NPC-search endpoint was evident in the endpoint list; verify this instead of assuming complete boss search.

Direct unauthenticated requests to the documentation and `/api/v1/items/5192` returned 403 from this machine. This establishes neither authenticated success nor the cause of rejection. Search/web retrieval could read documentation.

Confidence: strong advertised fit, limited operational validation. The [publisher changelog](https://foreverdb.net/ru/whats-new) acknowledges corrections including Classic/SoD contamination, removed-ability recommendations and delayed launch hotfix ingestion. Transparency is useful, but publisher claims are not independent validation. A [third-party integration tracker](https://wowforeverfr.com/atlas/suivi) and [Rust API wrapper](https://docs.rs/foreverdb-mcp/latest/foreverdb_mcp/) offer some adoption evidence, not accuracy certification. No substantial independent API rating/review sample was found. Do not confuse this domain with other projects also named ForeverDB.

### Everloot — promising open observations, immature deployment evidence

[API overview](https://everloot.app/docs/api), [quickstart](https://everloot.app/docs/quickstart) and [repository](https://github.com/Everloot/everloot) explicitly support outside tools. Documented surfaces include name lookup, items, typed entity relations and observed drop rollups. Public reads need no account; a free key increases selected endpoint limits. The docs distinguish game-file data from player observations, and unknown from zero. Player data requires CC BY-SA attribution; this is distinct from the AGPL code licence.

HTTP checks of name lookup, drop rollups, OpenAPI and health all returned 403 here. The documentation was readable through web research. These results do not prove outage or working backend access.

Confidence: attractive interface and provenance design, weak production proof. GitHub API at investigation time showed zero stars and one fork; those measure visibility, not quality. Recent changes indicate maintenance. The addon download page labels it Alpha with live-client verification pending. Open issues include [hard-coded storage-unavailable text](https://github.com/Everloot/everloot/issues/832) and [public API/documentation inconsistencies](https://github.com/Everloot/everloot/issues/827). These are maintainer reports, not proof that every public API response is broken. No strong independent accuracy reviews were found. An automated directory's pricing classification contradicted the primary docs, and another manifest scanner assigned risk for controls MCP cannot declare; neither is a useful quality rating.

### Blizzard Battle.net — preferred authority where coverage exists

[Developer portal](https://community.developer.battle.net/documentation/world-of-warcraft/game-data-apis) and [API terms](https://www.blizzard.com/en-us/legal/a2989b50-5f16-43b1-abec-2ae17cc09dd6/blizzard-developer-api-terms-of-use) establish supported developer access generally. Credentials are needed. Retail/Classic endpoint availability does not prove Forever support.

A [November 5 developer report](https://us.forums.blizzard.com/en/blizzard/t/wow-forever-api-what-works-so-far-plus-a-ts-client/60334) reports `static-forever-{region}`, `dynamic-forever-{region}`, and `profile-forever-{region}` working, with rulesets replacing realms. The author explicitly says this is undocumented probing and subject to change. Auction routes reportedly returned 404. No authenticated call was made here; specifically item search, item detail and boss loot coverage remain unverified. Other recent forum topics report profile 404s and ask when access will be available. Confidence is high in Blizzard as the authority, provisional in this newly reported Forever interface.

### Wowhead — verified tooltip reads, fragile discovery

The earlier endpoint results still apply. Rechecked Forever item 5192 successfully with HTTP 200. Tested `/forever/search/suggestions-template?q=cruel%20barb`, an endpoint pattern found in third-party research: 403. The historical [API request discussion](https://www.wowhead.com/forever/forums/topic/wowhead-api-for-items-characters-etc-187530) is background, not a current commercial-access commitment. A current documented general database API or paid data licence was not found. Ask Wowhead directly about partnership access before making bulk collection a dependency.

[AlvOps/wow-mcp-forever](https://github.com/AlvOps/wow-mcp-forever) offers Wowhead-backed name search, lookup and acquisition tools. This is a third-party adapter, not Wowhead granting access. GitHub API showed two stars, last push October 13, and a user issue about incorrect installation instructions. It does not establish that upstream access works from our deployment.

[Trustpilot](https://www.trustpilot.com/review/www.wowhead.com) had a small, mostly historical review sample, with praise for information and complaints about ads/access. It rates the consumer site, not API reliability or current Forever data. Do not use its score to choose a backend.

### AHledger — live API, failed edition consistency check

[Docs](https://ahledger.com/developers) advertise no-key JSON, 300 requests/minute and attribution. Primarily useful for market prices. The website documentation request returned 429, but the correct API host `api.ahledger.com` returned HTTP 200 for health and `/v1/items/5192?game=forever`.

Its Forever response returned Thief's Blade quality `UNCOMMON`, vendor sell 1803. Wowhead environment 16 returned rare quality and sell 2258; its Classic tooltip previously returned uncommon and sell 1803. This strongly suggests stale/Classic metadata on this AHledger record, but an in-game check is required to settle authority. An invalid game parameter returned 404, so the parameter is not simply ignored for every value. Do not use AHledger as authoritative Forever item metadata until the discrepancy is resolved.

Health reported current scan timestamps varying by market, which is useful evidence of ingestion but not a price-accuracy test. [Independent user comments](https://www.reddit.com/r/wowforever/comments/1wonwhx/auction_house_ledgerah_data_addon_alternatives/) describe setup/import failures. [Release feedback](https://www.reddit.com/r/wowaddons/comments/1x03nx2/introducing_ahledger_a_free_auction_house_economy/) includes executable-trust concerns and developer responses publishing code. Those comments concern the optional desktop software; we need only HTTP reads. API confidence: reachability verified, correctness mixed.

### Other sources and specialist services

- **Icy Veins:** [Forever database](https://db.icy-veins.com/wow-forever/) explicitly remains early access. No documented external database API found. Useful guides/reference; publisher reputation does not establish API suitability.
- **ForeverDiff / Forever Codex / GearInsight / Eternadex / WoWNexus:** useful discovery candidates, but no supported external API verified. Some explicitly use Classic baselines or beta snapshots. Do not treat multiple sites as independent agreement without examining their upstream sources.
- **Warcraft Wiki:** MediaWiki search/article access can help with lore and explanatory text; no current Forever item/loot completeness verified. Distinguish the wiki's discussion of the in-game Lua API from a web data API.
- **Warcraft Logs / Archon:** [Forever API docs](https://www.archon.gg/wow-forever/articles/help/api-documentation) describe OAuth and GraphQL. Good candidate for combat evidence, performance and observed player gear, not a full acquisition catalog. No authenticated test or Forever dataset completeness established. Uploaded high-performing gear does not itself prove causation or suitability for leveling.
- **Raider.IO:** [Forever developer API](https://forever.raider.io/api) documents character/guild/live-tracking data and use limits. Useful for profiles and progression; not the primary item/drop source. Not live-tested here.
- **TradeSkillMaster:** [official public data](https://tradeskillmaster.com/public-data) now offers CSV pricing dumps; current [support docs](https://support.tradeskillmaster.com/en_US/api-documentation) describe this instead of legacy API-key integration. [Community announcement/comments](https://www.reddit.com/r/woweconomy/comments/1upfwlu/public_auctiondb_data_dumps/) support that transition. Forever-specific feed availability was not verified. No reason to integrate for boss loot.
- **wago.tools / own game-file ingestion:** `/api/builds` returned 403 here. [WoWDBDefs](https://github.com/wowdev/WoWDBDefs) and [DBCD](https://github.com/wowdev/DBCD) are real client-table tooling. An owned index would require extraction, joins, hotfixes, build tracking and an observations source for server-side facts. This is a maintained data pipeline, not just adding search to the bot.
- **Historical Classic datasets / private-server databases / addon tables:** can seed IDs, names and explicitly marked baseline relationships. Never silently call them Forever data. Reuse licences and game edition must both be checked.

### Search and crawling providers

These help with discovery/guides rather than guaranteeing current structured game facts. No provider key was used, so none passed a Wowhead-specific end-to-end test.

- [Brave](https://brave.com/search/api/): direct web search; good candidate for name-to-page resolution.
- [Tavily](https://docs.tavily.com/documentation/api-reference/endpoint/search): search with domain filters and content options; candidate for guides plus supporting text.
- [Exa](https://exa.ai/docs/reference/search): search and content retrieval; another candidate for guide discovery.
- [Firecrawl](https://docs.firecrawl.dev/features/search): search plus scraping/extraction. Test whether required Wowhead sections actually appear, not merely whether a request succeeds. Also has a ForeverDB extraction integration, but direct ForeverDB API should be considered first.
- [Serper](https://serper.dev/) / [SerpApi](https://serpapi.com/search-api): Google-result access through a provider. They do not inherently solve subsequent page extraction.
- [SearXNG](https://docs.searxng.org/user/about.html): self-hostable metasearch querying other engines. It owns our query layer, not the underlying web index, and introduces upstream failures and hosting work.

Independent [developer comments](https://www.reddit.com/r/scrapingtheweb/comments/1tlkrla/honest_brave_search_api_review_after_3_months_of/) distinguish usable Brave discovery from difficulties fetching pages afterward. [Other hands-on comments](https://www.reddit.com/r/SearchAPIs/comments/1wrk0h1/tried_firecrawl_and_tavily_my_very_scuffed/) report varying content quality/latency. These are anecdotes, not audited measurements. Broad agent benchmarks are not evidence of Forever coverage; vendor comparison pages have obvious selection incentives. No numerical provider ranking is warranted without our own representative questions.

### Next validation gate

Before wiring tools into Discord, compare a small fixed set of Forever questions against candidate providers: exact/partial/ambiguous name lookup, changed Classic item, new Forever item, boss loot, quest reward, vendor source, filtering by required level/slot, and an unknown item. Check build, timestamp, evidence origin, pagination completeness and actual in-game agreement. Measure failures and latency from the deployment host. Obtain ForeverDB access only if we choose that candidate; prove Everloot can return usable nonempty observations; probe Blizzard with registered credentials.

The resulting bot can start with a direct discovery API plus Wowhead verification, adding a single search provider only for gaps and guides. No bulk Wowhead sync is required.
