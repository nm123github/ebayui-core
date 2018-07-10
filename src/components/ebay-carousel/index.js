const focusables = require('makeup-focusables');
const resizeUtil = require('../../common/event-utils').resizeUtil;
const emitAndFire = require('../../common/emit-and-fire');
const processHtmlAttributes = require('../../common/html-attributes');
const observer = require('../../common/property-observer');
const onScrollEnd = require('./utils/on-scroll-end');
const scrollTransition = require('./utils/scroll-transition');
const template = require('./template.marko');

function getInitialState(input) {
    const state = {
        config: {}, // A place to store values that should not trigger an update by themselves.
        gap: input.gap || 16,
        index: parseInt(input.index, 10) || 0,
        classes: ['carousel', input.class],
        itemsPerSlide: parseInt(input.itemsPerSlide, 10) || undefined,
        accessibilityPrev: input.accessibilityPrev || 'Previous Slide',
        accessibilityNext: input.accessibilityNext || 'Next Slide',
        accessibilityStatus: input.accessibilityStatus || 'Showing Slide {currentSlide} of {totalSlides} - Carousel',
        accessibilityCurrent: input.accessibilityCurrent || 'Current Slide {currentSlide} - Carousel',
        accessibilityOther: input.accessibilityOther || 'Slide {slide} - Carousel',
        htmlAttributes: processHtmlAttributes(input),
        items: (input.items || []).map(item => ({
            htmlAttributes: processHtmlAttributes(item),
            renderBody: item.renderBody
        }))
    };

    const { items, itemsPerSlide } = state;
    if (itemsPerSlide) {
        // Remove any extra items when using explicit itemsPerSlide.
        items.length -= items.length % itemsPerSlide;
        // Only allow infinite option for discrete carousels.
        state.infinite = input.infinite;
    }

    return state;
}

function getTemplateData(state) {
    let { index } = state;
    const { items, itemsPerSlide, slideWidth, gap } = state;
    const totalItems = items.length;
    index %= totalItems || 1; // Ensure index is within bounds.
    index -= index % (itemsPerSlide || 1); // Round index to the nearest valid slide index.
    index = state.index = Math.abs(index); // Ensure positive and save back to state.
    const offset = getOffset(state);
    const prevControlDisabled = !state.infinite && offset === 0;
    const nextControlDisabled = !state.infinite && offset === getMaxOffset(state);
    const bothControlsDisabled = prevControlDisabled && nextControlDisabled;
    let slide, itemWidth, totalSlides, accessibilityStatus;

    if (itemsPerSlide) {
        slide = Math.ceil(index / itemsPerSlide);
        itemWidth = `calc(${100 / itemsPerSlide}% - ${(itemsPerSlide - 1) * gap / itemsPerSlide}px)`;
        totalSlides = Math.ceil(items.length / itemsPerSlide);
        accessibilityStatus = state.accessibilityStatus
            .replace('{currentSlide}', slide + 1)
            .replace('{totalSlides}', totalSlides);
    } else {
        itemWidth = 'auto';
    }

    items.forEach((item, i) => {
        const { htmlAttributes: { style } } = item;
        const marginRight = i !== items.length && `${gap}px`;

        // Account for users providing a style string or object for each item.
        if (typeof style === 'string') {
            item.style = `${style};flex-basis:${itemWidth};margin-right:${marginRight}`;
        } else {
            item.style = Object.assign({}, style, {
                'flex-basis': itemWidth,
                'margin-right': marginRight
            });
        }

        item.fullyVisible = (
            item.left === undefined ||
            item.left - offset >= 0 &&
            item.right - offset <= slideWidth
        );
    });

    const data = Object.assign({}, state, {
        items,
        slide,
        offset,
        totalSlides,
        accessibilityStatus,
        prevControlDisabled,
        nextControlDisabled,
        bothControlsDisabled
    });

    return data;
}

function init() {
    const { state: { config } } = this;
    const listEl = this.listEl = this.getEl('list');
    this.containerEl = this.getEl('container');
    this.subscribeTo(resizeUtil).on('resize', onRender.bind(this));
    observer.observeRoot(this, ['index']);

    if (getComputedStyle(listEl).getPropertyValue('overflow-x') !== 'visible') {
        config.nativeScrolling = true;
        this.cancelScrollHandler = onScrollEnd(listEl, handleScrollEnd.bind(this));
    } else {
        this.subscribeTo(listEl).on('transitionend', this.emitUpdate.bind(this));
    }
}

function onRender() {
    const { listEl, state } = this;
    const { config } = state;

    // Stop scrolling if we were already moving.
    if (this.cancelScrollTransition) {
        this.cancelScrollTransition();
        this.cancelScrollTransition = undefined;
    }

    if (config.preserveItems) {
        // Track if we are on a normal render or a render caused by recalculating.
        config.preserveItems = false;

        // Ensure only visible items within the carousel are focusable.
        // We don't have access to these items in the template so me must update manually.
        forEls(listEl, itemEl => {
            focusables(itemEl).forEach(itemEl.getAttribute('aria-hidden') !== 'true'
                ? child => child.removeAttribute('tabindex')
                : child => child.setAttribute('tabindex', '-1')
            );
        });

        if (config.nativeScrolling) {
            const offset = getOffset(state);
            // Animate to the new scrolling position and emit update events afterward.
            this.cancelScrollTransition = scrollTransition(listEl, offset, () => {
                this.cancelScrollTransition = undefined;
                this.emitUpdate();
            });
        }

        return;
    }

    cancelAnimationFrame(this.renderFrame);
    this.renderFrame = requestAnimationFrame(() => {
        const { state: { items, itemsPerSlide } } = this;
        let slideWidth = this.containerEl.offsetWidth;
        // Accounts for partial pixel widths by adding another pixel
        // if we cannot divide up the slides evenly.
        if (itemsPerSlide && slideWidth % itemsPerSlide !== 0) slideWidth++;
        this.setState('slideWidth', slideWidth);
        config.preserveItems = true;

        // Update item positions in the dom.
        forEls(this.listEl, (itemEl, i) => {
            const item = items[i];
            item.left = itemEl.offsetLeft;
            item.right = item.left + itemEl.offsetWidth;
        });
    });
}

function onBeforeDestroy() {
    cancelAnimationFrame(this.renderFrame);
    if (this.cancelScrollHandler) this.cancelScrollHandler();
    if (this.cancelScrollTransition) this.cancelScrollTransition();
}

function emitUpdate() {
    const { state: { items } } = this;
    emitAndFire(this, 'carousel-update', {
        visibleIndexes: items
            .filter(({ fullyVisible }) => fullyVisible)
            .map(item => items.indexOf(item))
    });
}

/**
 * Moves the carousel in the `data-direction` of the clicked element if possible.
 *
 * @param {MouseEvent} originalEvent
 * @param {HTMLElement} target
 */
function handleMove(originalEvent, target) {
    const { state: { items, itemsPerSlide, infinite, slideWidth, config }, listEl } = this;
    const LEFT = -1;
    const RIGHT = 1;
    const direction = parseInt(target.getAttribute('data-direction'), 10);
    const nextIndex = this.getNextIndex(direction);
    const slide = itemsPerSlide && Math.ceil(nextIndex / itemsPerSlide);
    const goToSlide = () => {
        config.preserveItems = true;
        this.setState('index', nextIndex);
        emitAndFire(this, 'carousel-slide', { slide: slide + 1, originalEvent });
        emitAndFire(this, `carousel-${direction === 1 ? 'next' : 'prev'}`, { originalEvent });
    };

    // When we are in infinite mode we overshoot the desired index to land on a clone
    // of one of the ends. Then after the transition is over we update to the proper position.
    if (infinite) {
        if (config.disableTransition) return;
        let overrideOffset;

        if (direction === RIGHT && nextIndex === 0) {
            const { lastElementChild } = listEl;
            overrideOffset = lastElementChild.offsetLeft + lastElementChild.offsetWidth - slideWidth;
        } else if (direction === LEFT && slide === Math.ceil(items.length / itemsPerSlide)) {
            overrideOffset = 0;
        }

        if (overrideOffset !== undefined) {
            const { style } = listEl;
            style.transform = `translate3d(-${overrideOffset}px,0,0)`;
            this.subscribeTo(listEl).once('transitionend', () => {
                config.disableTransition = true;
                goToSlide();
                this.once('update', () => requestAnimationFrame(() => requestAnimationFrame(() => {
                    config.disableTransition = false;
                    style.transition = null;
                })));
            });
        } else {
            goToSlide();
        }
    } else {
        goToSlide();
    }
}

/**
 * Moves the carousel to the slide at `data-slide` for the clicked element if possible.
 *
 * @param {MouseEvent} originalEvent
 * @param {HTMLElement} target
 */
function handleDotClick(originalEvent, target) {
    const { state: { itemsPerSlide, config } } = this;
    const slide = parseInt(target.getAttribute('data-slide'), 10);
    config.preserveItems = true;
    this.setState('index', slide * itemsPerSlide);
    emitAndFire(this, 'carousel-slide', { slide: slide + 1, originalEvent });
}

/**
 * Find the closest item index to the scroll offset and triggers an update.
 *
 * @param {number} scrollLeft The current scroll position of the carousel.
 */
function handleScrollEnd(scrollLeft) {
    const { state: { items, config } } = this;

    // Find the closest item using a binary search.
    let start = 0;
    let end = items.length - 1;
    let remaining;
    let closest;

    while (end - start > 1) {
        remaining = end - start;
        const middle = start + Math.floor(remaining / 2);
        if (scrollLeft < items[middle].left) end = middle;
        else start = middle;
    }

    if (remaining === 0) {
        closest = start;
    } else {
        const deltaStart = Math.abs(scrollLeft - items[start].left);
        const deltaEnd = Math.abs(scrollLeft - items[end].left);
        closest = deltaStart < deltaEnd ? start : end;
    }

    const closestOffset = items[closest].left;
    const maxOffset = getMaxOffset(this.state);

    // If we are closer to the end than the closest item, then we just go to the end.
    if (Math.abs(maxOffset - scrollLeft) < Math.abs(closestOffset - scrollLeft)) {
        closest = items.length - 1;
    }

    // Always update with the new index to ensure the scroll animations happen.
    config.preserveItems = true;
    this.setStateDirty('index', closest);
}

/**
 * Given the current widget state, finds the active offset left of the selected item.
 * Also automatically caps the offset at the max offset.
 *
 * @param {object} state The widget state.
 * @return {number}
 */
function getOffset(state) {
    const { items, index } = state;
    if (!items.length) return 0;
    return Math.min(items[index].left, getMaxOffset(state));
}

/**
 * Given the current widget state, finds the last valid offset.
 *
 * @param {object} state The widget state.
 * @return {number}
 */
function getMaxOffset(state) {
    const { items, slideWidth } = state;
    if (!items.length) return 0;
    return Math.max(items[items.length - 1].right - slideWidth, 0);
}

/**
 * Calculates the next valid index in a direction.
 *
 * @param {-1|1} delta 1 for right and -1 for left.
 * @return {number}
 */
function getNextIndex(delta) {
    const { state: { index, items, slideWidth } } = this;
    const RIGHT = 1;
    const LEFT = -1;
    let i = index;
    let item;

    // If going backward from 0, we go to the end.
    if (delta === LEFT && i === 0) return items.length - 1;

    // Find the index of the next item that is not fully in view.
    do item = items[i += delta]; while (item && item.fullyVisible);

    // If going right, then we just want the next item not fully in view.
    if (delta === RIGHT) return i % items.length;

    // If going left, go as far left as possible while keeping this item fully in view.
    const targetOffset = item.right - slideWidth;
    do item = items[--i]; while (item && item.left >= targetOffset);
    return i + 1;
}

/**
 * Calls a function on each element within a parent element.
 *
 * @param {HTMLElement} parent The parent to walk through.
 * @param {(el: HTMLElement, i: number) => any} fn The function to call.
 */
function forEls(parent, fn) {
    let i = 0;
    let child = parent.firstElementChild;
    while (child) {
        if (!child.hasAttribute('data-clone')) {
            fn(child, i++);
        }
        child = child.nextElementSibling;
    }
}

module.exports = require('marko-widgets').defineComponent({
    template,
    getInitialState,
    getTemplateData,
    init,
    onRender,
    onBeforeDestroy,
    emitUpdate,
    handleMove,
    handleDotClick,
    getNextIndex
});
