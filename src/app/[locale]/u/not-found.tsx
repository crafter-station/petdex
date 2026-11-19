// Re-export the metadata as well as the component. `not-found.tsx` in this
// segment is the boundary Next renders when the page calls `notFound()`, and
// a boundary that only re-exports `default` drops the `generateMetadata` the
// shared file defines — so the 404 fell back to the root layout's metadata:
// an `index, follow` robots tag contradicting the `noindex` Next injects for
// the 404 status, the root site title instead of the 404 title, and a
// canonical pointing at the home page. Segments without their own boundary
// (pets, collections, vibe, kind) were unaffected, which is why only these
// two were wrong.
export { default, generateMetadata } from "../not-found";
