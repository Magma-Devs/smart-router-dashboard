/**
 * Where the dashboard opens, and the one place that says so.
 *
 * The root page, the edge gate's bounce for a signed-in visit to `/login` or
 * `/setup`, every form that ends in a sign-in, the two-factor page's way back,
 * and every account page's guard on a deployment without accounts all send
 * people here. One constant rather than a literal at each: a literal naming a
 * page keeps sending people there after the page has left the sidebar, and
 * nothing says so. `home-path.test.ts` checks that no redirect names a page
 * that does not exist, and that this one does.
 *
 * No imports: the edge proxy pulls this in through `auth.config.ts`.
 */
export const HOME_PATH = "/metrics";
