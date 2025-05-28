// background.js (Revised)

const MAX_CONCURRENT_DOWNLOADS = 5; // Changed from 15 for initial testing, you can set it to 15
let activeDownloads = 0;
let downloadQueue = []; // { url, subfolderName, filename, sendResponse }

// Helper to process the queue
function processDownloadQueue() {
  console.log(`Queue length: ${downloadQueue.length}, Active: ${activeDownloads}`);
  while (activeDownloads < MAX_CONCURRENT_DOWNLOADS && downloadQueue.length > 0) {
    const item = downloadQueue.shift();
    activeDownloads++;

    const downloadOptions = {
      url: item.url,
      filename: `${item.subfolderName}/${item.filename}`, // subfolderName is prepended
      conflictAction: 'uniquify', // Automatically rename if file exists
    };

    console.log(`Attempting to download: ${item.url} to ${downloadOptions.filename}`);
    chrome.downloads.download(downloadOptions, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error(`Download failed for ${item.url}: ${chrome.runtime.lastError.message}`);
        item.results.failed++;
      } else if (downloadId === undefined) {
        // This can happen if the download is disallowed (e.g. dangerous file, or blocked by other extension)
        console.warn(`Download initiation failed for ${item.url} (no downloadId). This might be a browser block.`);
        item.results.failed++;
      } else {
        console.log(`Download ${downloadId} started for ${item.url}`);
        // We don't increment item.results.succeeded here; we do it in onChanged listener
      }

      // This specific item's download attempt is done (either failed to start or ID received)
      // but we don't decrement activeDownloads here. That happens in onChanged.
      // If it failed to even get a downloadId, we effectively reduce activeDownloads count implicitly
      // for this item, but the onChanged listener won't fire for it. So, we manually "complete" it.
      if (downloadId === undefined || chrome.runtime.lastError) {
         activeDownloads--; // Manually decrement if download didn't start properly
         item.results.processed++;
         checkIfBatchComplete(item);
         processDownloadQueue(); // Try to process next
      }
    });
  }
}

// Listener for download changes (completion, interruption)
chrome.downloads.onChanged.addListener((downloadDelta) => {
  // Find the item in any active processing batch that corresponds to this downloadId
  // This is a bit tricky as we don't directly store downloadId with queue items yet.
  // For now, we'll just decrement activeDownloads and rely on the batch completion logic.
  // A more robust solution would map downloadId to queue items.

  if (downloadDelta.state) { // If the state changed
    console.log(`Download ${downloadDelta.id} state changed to ${downloadDelta.state.current}`);
    if (downloadDelta.state.current === 'complete' || downloadDelta.state.current === 'interrupted') {
      activeDownloads--;
      // Find which batch this download belonged to and update its counts
      // This part needs to be smarter if multiple download requests can be active.
      // For now, assume it belongs to the 'current' batch being handled by the message listener.
      // This is a simplification. A robust system would track download IDs.
      // Let's find the item in the original message's context (if available)
      // This is where the `item.results` passed around becomes crucial.
      // For now, we call processDownloadQueue directly.
      processDownloadQueue();
    }
  }
});


function checkIfBatchComplete(item) {
    if (item.results.processed === item.totalToProcess) {
        console.log(`Batch complete: ${item.results.succeeded} succeeded, ${item.results.failed} failed.`);
        try {
            item.sendResponse({
                status: `Downloads processed: ${item.results.succeeded} successful, ${item.results.failed} failed.`,
                succeeded: item.results.succeeded,
                failed: item.results.failed,
            });
        } catch (e) {
            console.warn("Could not send response, popup might have closed:", e);
        }
    }
}


// Listener for download state changes
// We need to associate downloadDelta.id with our queued items to accurately update counts.
// Let's store the sendResponse and result tracking with the queue item.
// This is a complex part. Let's simplify for now and make `sendResponse` more general.
// The `chrome.downloads.onChanged` listener will handle decrementing `activeDownloads`.
// The message listener will track overall progress for *its* batch.

chrome.downloads.onChanged.addListener(function(downloadDelta) {
    // Find the original request context if possible, this is hard without storing downloadId associations
    // For now, just decrement activeDownloads and trigger queue processing.
    if (downloadDelta.state && (downloadDelta.state.current === 'complete' || downloadDelta.state.current === 'interrupted')) {
        // A download finished or was interrupted
        // We need to find which 'batch' this belonged to update its specific counters.
        // This is where a global map of downloadId to batch context would be needed for high precision.
        // For simplicity now, we assume the last `onMessage` context is the one.

        // A download associated with SOME batch has finished or failed.
        // Let's find the batch by iterating through queue items that have a `batchId` or similar.
        // Or, more simply, the `item` in `processDownloadQueue` whose `downloadId` matches `downloadDelta.id`.
        // This requires storing `downloadId` on the `item` after `chrome.downloads.download` returns.

        // Simpler (but less accurate if multiple requests overlap perfectly):
        // Just decrement and try to process more. The batch completion logic in onMessage will handle counts.
        activeDownloads = Math.max(0, activeDownloads - 1); // Ensure it doesn't go below 0

        // The `processDownloadQueue()` will be called from within `onMessage` handler's loop
        // or when a download from *that specific batch* completes.
        // The key is that `processDownloadQueue` is called again to pick up new tasks.
    }
});


chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'downloadImages') {
    const { urls, subfolderName } = request;
    console.log(`Received request to download ${urls.length} images to subfolder: ${subfolderName}`);

    if (!urls || urls.length === 0) {
      sendResponse({ error: 'No URLs provided.' });
      return true;
    }

    // Sanitize subfolderName
    const sanitizedSubfolderName = subfolderName.replace(/[<>:"/\\|?*]+/g, '_').replace(/^\.+$/, '_').substring(0, 100) || "Downloads";

    let batchResults = {
        succeeded: 0,
        failed: 0,
        processed: 0, // How many have been attempted (start or fail-to-start)
        total: urls.length,
        sendResponse: sendResponse // Store sendResponse for this batch
    };

    urls.forEach((url, index) => {
      let filename = '';
      try {
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split('/');
        filename = decodeURIComponent(pathParts[pathParts.length - 1]); // Get last part of path

        // Remove query string from filename
        filename = filename.split('?')[0];

        if (!filename || !filename.match(/\.(png|jpe?g)$/i)) {
          const extMatch = url.match(/\.(png|jpe?g)(?:[#?]|$)/i); // Match extension before query or hash
          const extension = extMatch ? extMatch[1] : 'jpg';
          filename = `image_${Date.now()}_${index + 1}.${extension}`;
        }
        // Sanitize illegal characters for filenames
        filename = filename.replace(/[<>:"/\\|?*]+/g, '_').substring(0, 200); // Limit length
      } catch (e) {
        console.warn(`Invalid URL, cannot determine filename: ${url}`, e);
        filename = `image_fallback_${Date.now()}_${index + 1}.jpg`;
      }

      downloadQueue.push({
        url: url,
        subfolderName: sanitizedSubfolderName,
        filename: filename,
        batch: batchResults // Link to this batch's tracking
      });
    });

    processBatchQueue(batchResults); // Start processing for this specific batch

    return true; // Crucial: Indicates that sendResponse will be called asynchronously
  }
});

function processBatchQueue(batch) {
    console.log(`Processing batch. Active: ${activeDownloads}, Queue for this batch: ${downloadQueue.filter(i => i.batch === batch).length}`);

    while(activeDownloads < MAX_CONCURRENT_DOWNLOADS && downloadQueue.length > 0) {
        const item = downloadQueue.find(i => i.batch === batch); // Get next item for *this* batch
        if (!item) break; // No more items for this batch in the global queue

        // Remove item from global queue
        const itemIndex = downloadQueue.indexOf(item);
        if (itemIndex > -1) {
            downloadQueue.splice(itemIndex, 1);
        } else {
            // Should not happen if logic is correct
            console.error("Item believed to be in queue was not found!");
            batch.processed++; // count it as processed (failed to find)
            checkIfBatchFinallyComplete(batch);
            continue;
        }

        activeDownloads++;

        const downloadOptions = {
            url: item.url,
            filename: `${item.subfolderName}/${item.filename}`,
            conflictAction: 'uniquify',
        };

        console.log(`Attempting download: ${item.url} to ${downloadOptions.filename}`);
        chrome.downloads.download(downloadOptions, (downloadId) => {
            item.downloadId = downloadId; // Store downloadId for tracking

            if (chrome.runtime.lastError) {
                console.error(`Download init failed for ${item.url}: ${chrome.runtime.lastError.message}`);
                item.batch.failed++;
                activeDownloads--; // Decrement because it didn't really start
                item.batch.processed++;
                checkIfBatchFinallyComplete(item.batch);
                processBatchQueue(item.batch); // Try next for this batch
            } else if (downloadId === undefined) {
                console.warn(`Download did not start (no ID) for ${item.url}`);
                item.batch.failed++;
                activeDownloads--; // Decrement
                item.batch.processed++;
                checkIfBatchFinallyComplete(item.batch);
                processBatchQueue(item.batch); // Try next
            } else {
                console.log(`Download ${downloadId} initiated for ${item.url}`);
                // Success/failure for this one will be handled by onChanged listener
            }
        });
    }
}

// Revised onChanged listener
chrome.downloads.onChanged.addListener((downloadDelta) => {
    if (downloadDelta.id === undefined) return; // Should not happen

    // Find if any item in any active batch corresponds to this downloadId
    // This is complex if we don't have a global map of downloadId -> item.
    // The `downloadQueue` only holds items *waiting* to be downloaded.
    // We need a way to find the `item.batch` for a completed `downloadDelta.id`.
    //
    // **Simplification**: For now, the `onChanged` listener will just manage `activeDownloads`.
    // The `checkIfBatchFinallyComplete` will be called when a download *starts* (or fails to start).
    // This means `sendResponse` might happen *before* all files are truly written to disk,
    // but after Chrome has accepted them for download. This is a common compromise.
    //
    // For true completion tracking, you'd need to store the `item` (or its `batch` reference and `downloadId`)
    // in a temporary "in-progress" list when `chrome.downloads.download` is called,
    // then look it up in `onChanged`.

    if (downloadDelta.state) {
        console.log(`Download ${downloadDelta.id} state: ${downloadDelta.state.current}`);
        if (downloadDelta.state.current === 'complete') {
            // Ideally, find the batch this belonged to and increment `succeeded`
            // For now, this just frees up a slot.
            activeDownloads = Math.max(0, activeDownloads - 1);
            // Try to process more from any batch
            const nextBatchToProcess = downloadQueue.length > 0 ? downloadQueue[0].batch : null;
            if (nextBatchToProcess) processBatchQueue(nextBatchToProcess);

        } else if (downloadDelta.state.current === 'interrupted') {
            // Ideally, find the batch this belonged to and increment `failed`
            activeDownloads = Math.max(0, activeDownloads - 1);
            const nextBatchToProcess = downloadQueue.length > 0 ? downloadQueue[0].batch : null;
            if (nextBatchToProcess) processBatchQueue(nextBatchToProcess);
        }
    }
});


function checkIfBatchFinallyComplete(batch) {
    // This function is now called when a download *attempt* (start or immediate fail) is done.
    // It means `sendResponse` might happen before all files fully land on disk.
    if (batch.processed === batch.total) {
        console.log(`All ${batch.total} items for this batch have been processed (attempted). Succeeded (so far): ${batch.succeeded}, Failed (to start/initiate): ${batch.failed}`);
        // At this point, "succeeded" means "successfully handed off to Chrome's download manager".
        // The actual file writing might still be in progress or fail later.
        try {
            // Update: we should count actual successes from onChanged for a more accurate final count.
            // However, that makes sendResponse much more complex to time correctly.
            // For now, this response reflects "initiated" vs "failed to initiate".
            batch.sendResponse({
                status: `Download requests processed for ${batch.total} images. Check your downloads. Failures to start: ${batch.failed}.`,
                // Note: `succeeded` here would be (total - failed_to_start), not necessarily files on disk.
            });
        } catch (e) {
            console.warn("Could not send final response, popup likely closed:", e);
        }
    }
}

// To properly track success/failure from onChanged and link back to the batch:
// 1. When `chrome.downloads.download` gives a `downloadId`, store it with the `item` or in a map: `Map<downloadId, itemBatchContext>`.
// 2. In `chrome.downloads.onChanged`:
//    - Look up `downloadDelta.id` in your map to get the `itemBatchContext`.
//    - If `state.current === 'complete'`, increment `itemBatchContext.succeeded`.
//    - If `state.current === 'interrupted'`, increment `itemBatchContext.failed`.
//    - Always increment `itemBatchContext.processed_final` (a new counter for final states).
//    - Decrement `activeDownloads`.
//    - Call `processBatchQueue(itemBatchContext)` (or the next batch if this one is done).
//    - If `itemBatchContext.processed_final === itemBatchContext.total`, then call `sendResponse` with final counts.
// This makes the logic much more robust but also more complex. The provided `background.js` above simplifies this by responding earlier.

// Let's try a more robust `background.js` with better tracking.
// --- START OF MORE ROBUST BACKGROUND.JS ---
// background.js (More Robust Version Attempt)

const MAX_CONCURRENT_DOWNLOADS_ROBUST = 15; // As requested
let globalActiveDownloads = 0;
const robustDownloadQueue = []; // Stores { url, subfolderName, filename, batchContext }
const activeBatches = new Map(); // Map<batchId, batchContext>
let nextBatchId = 0;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'downloadImages') {
    const { urls, subfolderName } = request;
    console.log(`[Robust] Received request for ${urls.length} images to subfolder: ${subfolderName}`);

    if (!urls || urls.length === 0) {
      sendResponse({ error: 'No URLs provided.' });
      return true;
    }

    const currentBatchId = nextBatchId++;
    const batchContext = {
      id: currentBatchId,
      totalItems: urls.length,
      initiated: 0, // Successfully passed to chrome.downloads.download
      completed: 0, // state: complete
      failed: 0,    // state: interrupted, or failed to initiate
      sendResponse: sendResponse,
      items: [] // To store {url, filename, downloadId (once known)}
    };
    activeBatches.set(currentBatchId, batchContext);

    const sanitizedSubfolderName = subfolderName.replace(/[<>:"/\\|?*]+/g, '_').replace(/^\.+$/, '_').substring(0, 100) || "Downloads";

    urls.forEach((url, index) => {
      let filename = '';
      try {
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split('/');
        filename = decodeURIComponent(pathParts[pathParts.length - 1]);
        filename = filename.split('?')[0];
        if (!filename || !filename.match(/\.(png|jpe?g)$/i)) {
          const extMatch = url.match(/\.(png|jpe?g)(?:[#?]|$)/i);
          const extension = extMatch ? extMatch[1] : 'jpg';
          filename = `image_${Date.now()}_${index + 1}.${extension}`;
        }
        filename = filename.replace(/[<>:"/\\|?*]+/g, '_').substring(0, 200);
      } catch (e) {
        filename = `image_fallback_${Date.now()}_${index + 1}.jpg`;
      }

      const item = {
          url: url,
          subfolderName: sanitizedSubfolderName,
          filename: filename,
          batchId: currentBatchId,
          status: 'queued' // 'queued', 'initiating', 'downloading', 'complete', 'failed'
      };
      batchContext.items.push(item); // Add to batch's own list
      robustDownloadQueue.push(item); // Add to global download queue
    });

    console.log(`[Robust] Batch ${currentBatchId} created with ${batchContext.totalItems} items. Queue size: ${robustDownloadQueue.length}`);
    processRobustQueue();
    return true; // Asynchronous response
  }
});

function processRobustQueue() {
  while (globalActiveDownloads < MAX_CONCURRENT_DOWNLOADS_ROBUST && robustDownloadQueue.length > 0) {
    const item = robustDownloadQueue.shift(); // Get item from front of global queue
    if (!item) continue;

    const batchContext = activeBatches.get(item.batchId);
    if (!batchContext) {
        console.warn("[Robust] Batch context not found for item, skipping:", item);
        continue;
    }

    globalActiveDownloads++;
    item.status = 'initiating';

    const downloadOptions = {
      url: item.url,
      filename: `${item.subfolderName}/${item.filename}`,
      conflictAction: 'uniquify',
    };

    console.log(`[Robust] Attempting download: ${item.url} to ${downloadOptions.filename} (Batch ${item.batchId})`);
    chrome.downloads.download(downloadOptions, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error(`[Robust] Download init failed for ${item.url}: ${chrome.runtime.lastError.message}`);
        item.status = 'failed';
        batchContext.failed++;
        globalActiveDownloads--; // Didn't really become active
        checkBatchCompletion(batchContext);
        processRobustQueue(); // Try next
      } else if (downloadId === undefined) {
        console.warn(`[Robust] Download did not start (no ID) for ${item.url}`);
        item.status = 'failed';
        batchContext.failed++;
        globalActiveDownloads--;
        checkBatchCompletion(batchContext);
        processRobustQueue(); // Try next
      } else {
        console.log(`[Robust] Download ${downloadId} initiated for ${item.url}. Status: downloading.`);
        item.downloadId = downloadId;
        item.status = 'downloading';
        batchContext.initiated++;
        // Don't call checkBatchCompletion here yet, wait for onChanged
        // Don't call processRobustQueue here if successfully initiated, onChanged will handle freeing slot
      }
    });
  }
}

chrome.downloads.onChanged.addListener((downloadDelta) => {
  if (downloadDelta.id === undefined) return;

  // Find the item and its batch context
  let itemFound = null;
  let batchContextFound = null;

  for (const batch of activeBatches.values()) {
    const i = batch.items.find(it => it.downloadId === downloadDelta.id);
    if (i) {
      itemFound = i;
      batchContextFound = batch;
      break;
    }
  }

  if (!itemFound || !batchContextFound) {
    // console.log(`[Robust] onChanged: No active item found for downloadId ${downloadDelta.id}. Might be an unrelated download.`);
    return;
  }

  if (downloadDelta.state) {
    console.log(`[Robust] Download ${itemFound.downloadId} (${itemFound.url.substring(0,30)}...) state: ${downloadDelta.state.current}`);
    if (downloadDelta.state.current === 'complete' && itemFound.status !== 'complete') {
      itemFound.status = 'complete';
      batchContextFound.completed++;
      globalActiveDownloads--;
      checkBatchCompletion(batchContextFound);
      processRobustQueue();
    } else if (downloadDelta.state.current === 'interrupted' && itemFound.status !== 'failed') {
      itemFound.status = 'failed';
      batchContextFound.failed++; // Count it as failed if interrupted after initiation
      globalActiveDownloads--;
      checkBatchCompletion(batchContextFound);
      processRobustQueue();
    }
  }
});

function checkBatchCompletion(batchContext) {
  const processedCount = batchContext.completed + batchContext.failed;
  console.log(`[Robust] Batch ${batchContext.id} status: Total ${batchContext.totalItems}, Initiated ${batchContext.initiated}, Completed ${batchContext.completed}, Failed ${batchContext.failed}`);

  if (processedCount === batchContext.totalItems) {
    console.log(`[Robust] Batch ${batchContext.id} fully processed.`);
    try {
      batchContext.sendResponse({
        status: `Downloads finished for batch. ${batchContext.completed} successful, ${batchContext.failed} failed.`,
        succeeded: batchContext.completed,
        failed: batchContext.failed,
        total: batchContext.totalItems
      });
    } catch (e) {
      console.warn(`[Robust] Could not send final response for batch ${batchContext.id}, popup likely closed.`, e);
    }
    activeBatches.delete(batchContext.id); // Clean up completed batch
    console.log(`[Robust] Active batches remaining: ${activeBatches.size}`);
  }
}

// --- END OF MORE ROBUST BACKGROUND.JS ---
