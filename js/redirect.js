// A little redirect so old links don't break.
const target = document.body && document.body.dataset.redirect;

if (target) {
    const nextPage = new URL(target, location.href);
    nextPage.search = location.search;
    nextPage.hash = location.hash;
    location.replace(nextPage.href);
}
