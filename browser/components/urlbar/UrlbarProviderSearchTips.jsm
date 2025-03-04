/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/**
 * This module exports a provider that might show a tip when the user opens
 * the newtab or starts an organic search with their default search engine.
 */

var EXPORTED_SYMBOLS = ["UrlbarProviderSearchTips"];

const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);

XPCOMUtils.defineLazyModuleGetters(this, {
  AppMenuNotifications: "resource://gre/modules/AppMenuNotifications.jsm",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.jsm",
  Log: "resource://gre/modules/Log.jsm",
  ProfileAge: "resource://gre/modules/ProfileAge.jsm",
  Services: "resource://gre/modules/Services.jsm",
  setTimeout: "resource://gre/modules/Timer.jsm",
  UrlbarPrefs: "resource:///modules/UrlbarPrefs.jsm",
  UrlbarProvider: "resource:///modules/UrlbarUtils.jsm",
  UrlbarProviderTopSites: "resource:///modules/UrlbarProviderTopSites.jsm",
  UrlbarResult: "resource:///modules/UrlbarResult.jsm",
  UrlbarUtils: "resource:///modules/UrlbarUtils.jsm",
});

XPCOMUtils.defineLazyGetter(this, "logger", () =>
  Log.repository.getLogger("Urlbar.Provider.SearchTips")
);

XPCOMUtils.defineLazyServiceGetter(
  this,
  "updateManager",
  "@mozilla.org/updates/update-manager;1",
  "nsIUpdateManager"
);

XPCOMUtils.defineLazyPreferenceGetter(
  this,
  "cfrFeaturesUserPref",
  "browser.newtabpage.activity-stream.asrouter.userprefs.cfr.features",
  true
);

// The possible tips to show.
const TIPS = {
  NONE: "",
  ONBOARD: "onboard",
  REDIRECT: "redirect",
};

// This maps engine names to regexes matching their homepages. We show the
// redirect tip on these pages. The Google domains are taken from
// https://ipfs.io/ipfs/QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco/wiki/List_of_Google_domains.html.
const SUPPORTED_ENGINES = new Map([
  ["Bing", { domainPath: /^www\.bing\.com\/$/ }],
  [
    "DuckDuckGo",
    {
      domainPath: /^(start\.)?duckduckgo\.com\/$/,
      prohibitedSearchParams: ["q"],
    },
  ],
  [
    "Google",
    {
      domainPath: /^www\.google\.(com|ac|ad|ae|com\.af|com\.ag|com\.ai|al|am|co\.ao|com\.ar|as|at|com\.au|az|ba|com\.bd|be|bf|bg|com\.bh|bi|bj|com\.bn|com\.bo|com\.br|bs|bt|co\.bw|by|com\.bz|ca|com\.kh|cc|cd|cf|cat|cg|ch|ci|co\.ck|cl|cm|cn|com\.co|co\.cr|com\.cu|cv|com\.cy|cz|de|dj|dk|dm|com\.do|dz|com\.ec|ee|com\.eg|es|com\.et|fi|com\.fj|fm|fr|ga|ge|gf|gg|com\.gh|com\.gi|gl|gm|gp|gr|com\.gt|gy|com\.hk|hn|hr|ht|hu|co\.id|iq|ie|co\.il|im|co\.in|io|is|it|je|com\.jm|jo|co\.jp|co\.ke|ki|kg|co\.kr|com\.kw|kz|la|com\.lb|com\.lc|li|lk|co\.ls|lt|lu|lv|com\.ly|co\.ma|md|me|mg|mk|ml|com\.mm|mn|ms|com\.mt|mu|mv|mw|com\.mx|com\.my|co\.mz|com\.na|ne|com\.nf|com\.ng|com\.ni|nl|no|com\.np|nr|nu|co\.nz|com\.om|com\.pk|com\.pa|com\.pe|com\.ph|pl|com\.pg|pn|com\.pr|ps|pt|com\.py|com\.qa|ro|rs|ru|rw|com\.sa|com\.sb|sc|se|com\.sg|sh|si|sk|com\.sl|sn|sm|so|st|sr|com\.sv|td|tg|co\.th|com\.tj|tk|tl|tm|to|tn|com\.tr|tt|com\.tw|co\.tz|com\.ua|co\.ug|co\.uk|com\.uy|co\.uz|com\.vc|co\.ve|vg|co\.vi|com\.vn|vu|ws|co\.za|co\.zm|co\.zw)\/(webhp)?$/,
    },
  ],
]);

// The maximum number of times we'll show a tip across all sessions.
const MAX_SHOWN_COUNT = 4;

// Amount of time to wait before showing a tip after selecting a tab or
// navigating to a page where we should show a tip.
const SHOW_TIP_DELAY_MS = 200;

// We won't show a tip if the browser has been updated in the past
// LAST_UPDATE_THRESHOLD_MS.
const LAST_UPDATE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * A provider that sometimes returns a tip result when the user visits the
 * newtab page or their default search engine's homepage.
 */
class ProviderSearchTips extends UrlbarProvider {
  constructor() {
    super();
    // Maps the running queries by queryContext.
    this.queries = new Map();

    // Whether we've shown a tip in the current browser session.
    this.showedTipInCurrentSession = false;
    // Whether we've shown a tip in the current engagement.
    this.showedTipInCurrentEngagement = false;
  }

  get PRIORITY() {
    // Search tips are prioritized over the UnifiedComplete and top sites
    // providers.
    return UrlbarProviderTopSites.PRIORITY + 1;
  }

  /**
   * Unique name for the provider, used by the context to filter on providers.
   * Not using a unique name will cause the newest registration to win.
   */
  get name() {
    return "UrlbarProviderSearchTips";
  }

  /**
   * The type of the provider.
   */
  get type() {
    return UrlbarUtils.PROVIDER_TYPE.IMMEDIATE;
  }

  /**
   * Whether this provider should be invoked for the given context.
   * If this method returns false, the providers manager won't start a query
   * with this provider, to save on resources.
   * @param {UrlbarQueryContext} queryContext The query context object
   * @returns {boolean} Whether this provider should be invoked for the search.
   */
  isActive(queryContext) {
    return (
      UrlbarPrefs.get("update1.searchTips") &&
      this.currentTip &&
      cfrFeaturesUserPref
    );
  }

  /**
   * Gets the provider's priority.
   * @param {UrlbarQueryContext} queryContext The query context object
   * @returns {number} The provider's priority for the given query.
   */
  getPriority(queryContext) {
    return this.PRIORITY;
  }

  /**
   * Starts querying.
   * @param {UrlbarQueryContext} queryContext The query context object
   * @param {function} addCallback Callback invoked by the provider to add a new
   *        result. A UrlbarResult should be passed to it.
   * @note Extended classes should return a Promise resolved when the provider
   *       is done searching AND returning results.
   */
  async startQuery(queryContext, addCallback) {
    let instance = {};
    this.queries.set(queryContext, instance);

    let tip = this.currentTip;
    this.currentTip = TIPS.NONE;

    this.showedTipInCurrentEngagement = true;

    let defaultEngine = await Services.search.getDefault();

    let result = new UrlbarResult(
      UrlbarUtils.RESULT_TYPE.TIP,
      UrlbarUtils.RESULT_SOURCE.OTHER_LOCAL,
      {
        buttonTextData: { id: "urlbar-search-tips-confirm" },
        icon: defaultEngine.iconURI.spec,
      }
    );

    switch (tip) {
      case TIPS.ONBOARD:
        result.heuristic = true;
        result.payload.textData = {
          id: "urlbar-search-tips-onboard",
          args: {
            engineName: defaultEngine.name,
          },
        };
        break;
      case TIPS.REDIRECT:
        result.heuristic = false;
        result.payload.textData = {
          id: "urlbar-search-tips-redirect",
          args: {
            engineName: defaultEngine.name,
          },
        };
        break;
    }

    if (!this.queries.has(queryContext)) {
      return;
    }

    addCallback(this, result);
    this.queries.delete(queryContext);
  }

  /**
   * Cancels a running query,
   * @param {UrlbarQueryContext} queryContext the query context object to cancel
   *        query for.
   */
  cancelQuery(queryContext) {
    logger.info(`Canceling query for ${queryContext.searchString}`);
    this.queries.delete(queryContext);
  }

  /**
   * Called when the tip is selected.
   * @param {UrlbarResult} result
   *   The result that was picked.
   */
  pickResult(result) {
    let window = BrowserWindowTracker.getTopWindow();
    window.gURLBar.value = "";
    window.SetPageProxyState("invalid");
    window.gURLBar.focus();
  }

  /**
   * Called when the user starts and ends an engagement with the urlbar.
   *
   * @param {boolean} isPrivate True if the engagement is in a private context.
   * @param {string} state The state of the engagement, one of: start,
   *        engagement, abandonment, discard.
   */
  onEngagement(isPrivate, state) {
    if (this.showedTipInCurrentEngagement && state == "engagement") {
      // The user either clicked the tip's "Okay, Got It" button, or they
      // engaged with the urlbar while the tip was showing. We treat both as
      // the user's acknowledgment of the tip, and we don't show tips again in any
      // session. Set the shown count to the max.
      Services.prefs.setIntPref(
        "browser.urlbar.searchTips.shownCount",
        MAX_SHOWN_COUNT
      );
    }
    this.showedTipInCurrentEngagement = false;
  }

  /**
   * Called from `onLocationChange` in browser.js.
   * @param {URL} uri
   *  The URI being navigated to.
   */
  onLocationChange(uri) {
    let window = BrowserWindowTracker.getTopWindow();
    // The UrlbarView is usually closed on location change when the input is
    // blurred. Since we open the view to show the redirect tip without focusing
    // the input, the view won't close in that case. We need to close it manually.
    if (this.showedTipInCurrentEngagement) {
      window.gURLBar.view.close();
    }
    this._maybeShowTipForUrl(uri.spec);
  }

  /**
   * Determines whether we should show a tip for the current tab, sets
   * this.currentTip, and starts a search on an empty string.
   * @param {number} urlStr
   *   The URL of the page being loaded, in string form.
   */
  async _maybeShowTipForUrl(urlStr) {
    let instance = {};
    this._maybeShowTipForUrlInstance = instance;
    // We show only one tip per session, so if we've shown one already, stop.
    if (this.showedTipInCurrentSession) {
      return;
    }

    // Get the number of times we've shown a tip over all sessions. If it's the
    // max, don't show it again.
    let shownCount = UrlbarPrefs.get("searchTips.shownCount");

    if (shownCount >= MAX_SHOWN_COUNT) {
      return;
    }

    // Don't show a tip if the browser is already showing some other notification.
    if (isBrowserShowingNotification()) {
      return;
    }

    // Don't show a tip if the browser has been updated recently.
    let date = await lastBrowserUpdateDate();
    if (Date.now() - date <= LAST_UPDATE_THRESHOLD_MS) {
      return;
    }

    // Determine which tip we should show for the tab.
    let tip;
    let isNewtab = ["about:newtab", "about:home"].includes(urlStr);
    let isSearchHomepage = !isNewtab && (await isDefaultEngineHomepage(urlStr));
    if (isNewtab) {
      tip = TIPS.ONBOARD;
    } else if (isSearchHomepage) {
      tip = TIPS.REDIRECT;
    } else {
      // No tip.
      return;
    }

    // At this point, we're showing a tip.
    this.showedTipInCurrentSession = true;

    // Store the new shown count.
    Services.prefs.setIntPref(
      "browser.urlbar.searchTips.shownCount",
      shownCount + 1
    );

    // Start a search.
    setTimeout(() => {
      if (this._maybeShowTipForUrlInstance != instance) {
        return;
      }

      this.currentTip = tip;
      if (!this.isActive()) {
        return;
      }

      let window = BrowserWindowTracker.getTopWindow();
      window.gURLBar.search("", { focus: tip == TIPS.ONBOARD });
    }, SHOW_TIP_DELAY_MS);
  }
}

function isBrowserShowingNotification() {
  let window = BrowserWindowTracker.getTopWindow();

  // urlbar view and notification box (info bar)
  if (
    window.gURLBar.view.isOpen ||
    window.gBrowser.getNotificationBox().currentNotification
  ) {
    return true;
  }

  // app menu notification doorhanger
  if (
    AppMenuNotifications.activeNotification &&
    !AppMenuNotifications.activeNotification.dismissed &&
    !AppMenuNotifications.activeNotification.options.badgeOnly
  ) {
    return true;
  }

  // tracking protection and identity box doorhangers
  if (
    ["tracking-protection-icon-container", "identity-box"].some(
      id => window.document.getElementById(id).getAttribute("open") == "true"
    )
  ) {
    return true;
  }

  // page action button panels
  let pageActions = window.document.getElementById("page-action-buttons");
  if (pageActions) {
    for (let child of pageActions.childNodes) {
      if (child.getAttribute("open") == "true") {
        return true;
      }
    }
  }

  // toolbar button panels
  let navbar = window.document.getElementById("nav-bar-customization-target");
  for (let node of navbar.querySelectorAll("toolbarbutton")) {
    if (node.getAttribute("open") == "true") {
      return true;
    }
  }

  return false;
}

/**
 * Checks if the given URL is the homepage of the current default search engine.
 * Returns false if the default engine is not listed in SUPPORTED_ENGINES.
 * @param {string} urlStr
 *   The URL to check, in string form.
 *
 * @returns {boolean}
 */
async function isDefaultEngineHomepage(urlStr) {
  let defaultEngine = await Services.search.getDefault();
  if (!defaultEngine) {
    return false;
  }

  let homepageMatches = SUPPORTED_ENGINES.get(defaultEngine.name);
  if (!homepageMatches) {
    return false;
  }

  // The URL object throws if the string isn't a valid URL.
  let url;
  try {
    url = new URL(urlStr);
  } catch (e) {
    return false;
  }

  if (url.searchParams.has(homepageMatches.prohibitedSearchParams)) {
    return false;
  }

  // Strip protocol and query params.
  urlStr = url.hostname.concat(url.pathname);

  return homepageMatches.domainPath.test(urlStr);
}

async function lastBrowserUpdateDate() {
  // Get the newest update in the update history. This isn't perfect
  // because these dates are when updates are applied, not when the
  // user restarts with the update. See bug 1595328.
  if (updateManager && updateManager.updateCount) {
    let update = updateManager.getUpdateAt(0);
    return update.installDate;
  }
  // Fall back to the profile age.
  let age = await ProfileAge();
  return (await age.firstUse) || age.created;
}

var UrlbarProviderSearchTips = new ProviderSearchTips();
