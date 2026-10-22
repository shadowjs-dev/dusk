import { errorBoundaries } from "@shadow-js/router/errors";
import { matchFilters } from "@shadow-js/router/filters";
import { headManagement } from "@shadow-js/router/head";
import { loaderCache } from "@shadow-js/router/loaders";
import { notFoundUi } from "@shadow-js/router/not-found";
import { pendingUi } from "@shadow-js/router/pending";
import { searchValidation } from "@shadow-js/router/search";
import { apiRoutes } from "../../src/features/api-routes";
import { dataCache } from "../../src/features/data-cache";
import { draftMode } from "../../src/features/draft-mode";
import { images } from "../../src/features/images";
import { isr } from "../../src/features/isr";
import { pages } from "../../src/features/pages";
import { routing } from "../../src/features/routing";
import { rpc } from "../../src/features/rpc";
import { streams } from "../../src/features/streams";
import type { DuskFeature } from "../../src/server/features";

/**
 * Every feature, in the order the generated server entry passes them (`vite/virtual.ts`). A test that builds a
 * handler for a whole app passes these; a test of one feature passes only that feature. The pages feature gets every
 * router feature and the metadata engine: a test app may use any export, and the generated entry passes only the ones
 * its routes use.
 */
export function allFeatures(): DuskFeature[] {
  // The loader is what the generated entry passes when a page sets `dynamicParams = false`; a test app may have one.
  return [
    routing(),
    pages({
      dynamicParams: () => import("../../src/server/dynamic-params"),
      metadata: () => import("../../src/metadata/server"),
      routerFeatures: [
        loaderCache({}),
        headManagement(),
        errorBoundaries(),
        matchFilters(),
        searchValidation(),
        notFoundUi(),
        pendingUi(),
      ],
    }),
    dataCache(),
    isr(),
    rpc(),
    apiRoutes(),
    streams(),
    images(),
    draftMode(),
  ];
}
