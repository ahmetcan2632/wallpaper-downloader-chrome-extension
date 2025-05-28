const folderNameInput = document.getElementById('folderName');
const downloadButton = document.getElementById('downloadButton');
const statusDiv = document.getElementById('status');
const imagePreviewsDiv = document.getElementById('imagePreviews');
const imagePreviewContainer = document.getElementById('imagePreviewContainer');
const selectAllButton = document.getElementById('selectAllButton');
const deselectAllButton = document.getElementById('deselectAllButton');
const instructionsDiv = document.getElementById('instructions');

// New UI elements for download limit
const downloadLimitContainer = document.getElementById('downloadLimitContainer');
const downloadLimitInput = document.getElementById('downloadLimit');
const decreaseLimitBtn = document.getElementById('decreaseLimitBtn');
const increaseLimitBtn = document.getElementById('increaseLimitBtn');

let foundImageUrls = [];
let selectedImageUrls = new Set();
let currentButtonAction = 'scan'; // 'scan' or 'download'

// --- Initialization ---
function initializePopup() {
    // Load saved folder name
    chrome.storage.sync.get(['downloadSubfolderName', 'downloadLimitCount'], (result) => {
        if (result.downloadSubfolderName) {
            folderNameInput.value = result.downloadSubfolderName;
        } else {
            folderNameInput.value = "DownloadedWallpapers"; // Default
        }
        if (result.downloadLimitCount !== undefined) {
            downloadLimitInput.value = result.downloadLimitCount;
        } else {
            downloadLimitInput.value = 0; // Default to 0 (all)
        }
    });

    folderNameInput.addEventListener('input', () => {
        chrome.storage.sync.set({ downloadSubfolderName: folderNameInput.value });
    });

    downloadLimitInput.addEventListener('input', () => {
        let limit = parseInt(downloadLimitInput.value, 10);
        if (isNaN(limit) || limit < 0) limit = 0; // Ensure non-negative, default to 0 if invalid
        downloadLimitInput.value = limit; // Correct invalid input
        chrome.storage.sync.set({ downloadLimitCount: limit });
        updateDownloadButtonText(); // Update button text if limit changes
    });

    decreaseLimitBtn.addEventListener('click', () => {
        let limit = parseInt(downloadLimitInput.value, 10);
        if (isNaN(limit)) limit = 0;
        limit = Math.max(0, limit - 1); // Cannot go below 0
        downloadLimitInput.value = limit;
        chrome.storage.sync.set({ downloadLimitCount: limit });
        updateDownloadButtonText();
    });

    increaseLimitBtn.addEventListener('click', () => {
        let limit = parseInt(downloadLimitInput.value, 10);
        if (isNaN(limit)) limit = 0;
        limit += 1;
        downloadLimitInput.value = limit;
        chrome.storage.sync.set({ downloadLimitCount: limit });
        updateDownloadButtonText();
    });

    downloadButton.addEventListener('click', handleButtonClick);
    selectAllButton.addEventListener('click', selectAllImages);
    deselectAllButton.addEventListener('click', deselectAllImages);

    updateUIState('initial');
}

// --- UI State Management ---
function updateUIState(state) {
    switch (state) {
        case 'initial':
            instructionsDiv.textContent = '1. Click "Start Scan" to find images.';
            downloadLimitContainer.style.display = 'none';
            imagePreviewContainer.style.display = 'none';
            selectAllButton.style.display = 'none';
            deselectAllButton.style.display = 'none';
            downloadButton.textContent = 'Start Scan';
            currentButtonAction = 'scan';
            statusDiv.textContent = '';
            break;
        case 'scanning':
            instructionsDiv.textContent = 'Scanning page for images...';
            downloadButton.disabled = true;
            downloadButton.textContent = 'Scanning...';
            statusDiv.textContent = 'Working...';
            break;
        case 'images_found':
            instructionsDiv.textContent = '2. Select images below. 3. Set optional limit. 4. Download.';
            downloadLimitContainer.style.display = 'block';
            imagePreviewContainer.style.display = 'block';
            selectAllButton.style.display = 'inline-block';
            deselectAllButton.style.display = 'inline-block';
            currentButtonAction = 'download';
            updateDownloadButtonText(); // Will set button text based on selection and limit
            break;
        case 'no_images_found':
            instructionsDiv.textContent = 'No suitable images found. Try another page or click "Start Scan" again.';
            downloadLimitContainer.style.display = 'none';
            imagePreviewContainer.style.display = 'none';
            selectAllButton.style.display = 'none';
            deselectAllButton.style.display = 'none';
            downloadButton.textContent = 'Start Scan';
            currentButtonAction = 'scan';
            statusDiv.textContent = 'No .png or .jpeg/.jpg images found.';
            break;
        case 'downloading':
            instructionsDiv.textContent = 'Downloading images... Please wait.';
            downloadButton.disabled = true;
            statusDiv.textContent = 'Sending to downloads...';
            break;
        case 'download_complete':
            // Reset to initial or a specific post-download state
            updateUIState('initial'); // Or a custom message
            // statusDiv could show the response from background.js
            break;
    }
    if (state !== 'scanning' && state !== 'downloading') {
        downloadButton.disabled = false;
    }
}


// --- Core Logic ---
async function handleButtonClick() {
  if (currentButtonAction === 'scan') {
    await scanForImages();
  } else if (currentButtonAction === 'download') {
    downloadSelectedImagesWithLimit();
  }
}

async function scanForImages() {
  updateUIState('scanning');
  imagePreviewsDiv.innerHTML = '';
  foundImageUrls = [];
  selectedImageUrls.clear();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.id || (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('https://chrome.google.com/webstore')))) {
    statusDiv.textContent = tab.url ? 'Cannot run on this type of page.' : 'Error: Could not get active tab.';
    updateUIState('initial'); // Reset to allow trying again
    return;
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapeImagesFromPageInTab,
    });

    if (chrome.runtime.lastError) {
      statusDiv.textContent = `Error during scan: ${chrome.runtime.lastError.message}`;
      console.error("Scan error:", chrome.runtime.lastError);
      updateUIState('initial');
      return;
    }

    if (results && results[0] && results[0].result) {
      foundImageUrls = results[0].result; // Unique full URLs
      if (foundImageUrls.length > 0) {
        statusDiv.textContent = `Found ${foundImageUrls.length} unique images.`;
        displayImagePreviews(foundImageUrls);
        selectAllImages(); // Select all by default after scan
        updateUIState('images_found');
      } else {
        updateUIState('no_images_found');
      }
    } else {
      statusDiv.textContent = 'No images found or script failed.';
      updateUIState('no_images_found');
    }
  } catch (e) {
    statusDiv.textContent = `Error executing script: ${e.message}`;
    console.error("Error executing script:", e);
    updateUIState('initial');
  }
}

function scrapeImagesFromPageInTab() { // This runs in the content script
  const imageExtensions = ['.png', '.jpeg', '.jpg'];
  const foundImagesMap = new Map(); // Key: baseUrl, Value: originalFullUrl

  function isValidHttpUrl(string) {
    let url; try { url = new URL(string); } catch (_) { return false; }
    return url.protocol === "http:" || url.protocol === "https:";
  }

  function processImageUrl(fullUrlCandidate) {
    try {
      if (!(fullUrlCandidate && (fullUrlCandidate.startsWith('http:') || fullUrlCandidate.startsWith('https:') || fullUrlCandidate.startsWith('//')))) {
         return;
      }
      // If scheme-relative, prepend current page's protocol
      let absoluteUrlCandidate = fullUrlCandidate;
      if (fullUrlCandidate.startsWith('//')) {
        absoluteUrlCandidate = document.location.protocol + fullUrlCandidate;
      }

      const fullUrl = new URL(absoluteUrlCandidate, document.baseURI).href;

      if (!isValidHttpUrl(fullUrl)) return;

      const baseUrl = fullUrl.split('?')[0].split('#')[0];
      const pathForExtensionCheck = baseUrl.toLowerCase();

      if (imageExtensions.some(ext => pathForExtensionCheck.endsWith(ext))) {
        if (!foundImagesMap.has(baseUrl)) {
          foundImagesMap.set(baseUrl, fullUrl);
        }
      }
    } catch (e) { /* console.warn("Error processing URL:", fullUrlCandidate, e); */ }
  }

  document.querySelectorAll('img').forEach(img => {
    let srcCandidate = img.currentSrc || img.src;
    if (srcCandidate) processImageUrl(srcCandidate);
    if (img.srcset) {
      img.srcset.split(',').forEach(source => {
        const parts = source.trim().split(/\s+/);
        if (parts.length > 0) processImageUrl(parts[0]);
      });
    }
  });
  // Add Picture sources
  document.querySelectorAll('picture source').forEach(source => {
      if(source.srcset){
          source.srcset.split(',').forEach(srcEntry => {
              const parts = srcEntry.trim().split(/\s+/);
              if(parts.length > 0) processImageUrl(parts[0]);
          });
      }
  });

  return Array.from(foundImagesMap.values());
}


function displayImagePreviews(urls) {
  imagePreviewsDiv.innerHTML = ''; // Clear previous
  urls.forEach(url => {
    const imgEl = document.createElement('img');
    imgEl.src = url;
    imgEl.title = url.substring(url.lastIndexOf('/') + 1).split('?')[0];
    imgEl.dataset.url = url;
    imgEl.addEventListener('click', () => toggleImageSelection(imgEl, url));
    imagePreviewsDiv.appendChild(imgEl);
  });
  // Visual update for selection will be handled by selectAll/deselectAll or toggleImageSelection
}

function toggleImageSelection(imgEl, url) {
  if (selectedImageUrls.has(url)) {
    selectedImageUrls.delete(url);
    imgEl.classList.remove('selected');
    imgEl.classList.add('deselected');
  } else {
    selectedImageUrls.add(url);
    imgEl.classList.add('selected');
    imgEl.classList.remove('deselected');
  }
  updateDownloadButtonText();
  statusDiv.textContent = `${selectedImageUrls.size} of ${foundImageUrls.length} images selected.`;
}

function selectAllImages() {
  foundImageUrls.forEach(url => selectedImageUrls.add(url));
  updatePreviewSelectionVisuals();
}

function deselectAllImages() {
  selectedImageUrls.clear();
  updatePreviewSelectionVisuals();
}

function updatePreviewSelectionVisuals() {
  const previewImages = imagePreviewsDiv.querySelectorAll('img');
  previewImages.forEach(imgEl => {
    if (selectedImageUrls.has(imgEl.dataset.url)) {
      imgEl.classList.add('selected');
      imgEl.classList.remove('deselected');
    } else {
      imgEl.classList.remove('selected');
      imgEl.classList.add('deselected');
    }
  });
  updateDownloadButtonText();
  if (foundImageUrls.length > 0) {
    statusDiv.textContent = `${selectedImageUrls.size} of ${foundImageUrls.length} images selected.`;
  }
}

function updateDownloadButtonText() {
    if (currentButtonAction !== 'download') return;

    const limit = parseInt(downloadLimitInput.value, 10);
    const effectiveLimit = (isNaN(limit) || limit <= 0) ? selectedImageUrls.size : Math.min(limit, selectedImageUrls.size);

    if (selectedImageUrls.size === 0) {
        downloadButton.textContent = 'Select Images';
        downloadButton.disabled = true; // Disable if nothing is selected
    } else {
        downloadButton.textContent = `Download ${effectiveLimit} Selected`;
        downloadButton.disabled = false;
    }
}


function downloadSelectedImagesWithLimit() {
  const subfolder = folderNameInput.value.trim() || 'DownloadedWallpapers';
  if (selectedImageUrls.size === 0) {
    statusDiv.textContent = 'No images selected to download.';
    return;
  }

  let limit = parseInt(downloadLimitInput.value, 10);
  if (isNaN(limit) || limit <= 0) { // 0 or invalid means download all selected
    limit = selectedImageUrls.size;
  }

  // Convert Set to Array to easily slice and maintain selection order (insertion order for Set)
  const urlsToDownload = Array.from(selectedImageUrls).slice(0, limit);

  if (urlsToDownload.length === 0) {
      statusDiv.textContent = 'No images to download with current limit.';
      return;
  }

  updateUIState('downloading');
  statusDiv.textContent = `Requesting download for ${urlsToDownload.length} of ${selectedImageUrls.size} selected images...`;

  chrome.runtime.sendMessage({
    action: 'downloadImages',
    urls: urlsToDownload,
    subfolderName: subfolder,
  }, (response) => {
    updateUIState('download_complete'); // Reset UI after attempting
    if (chrome.runtime.lastError) {
      statusDiv.textContent = `Error: ${chrome.runtime.lastError.message}`;
      console.error("Message sending error:", chrome.runtime.lastError);
    } else if (response) {
      if (response.error) {
        statusDiv.textContent = `Error: ${response.error}`;
      } else {
         statusDiv.textContent = response.status || "Download process initiated.";
         if (response.succeeded !== undefined && response.failed !== undefined && response.total !== undefined) {
            statusDiv.textContent = `Downloads: ${response.succeeded} successful, ${response.failed} failed of ${response.total} requested.`;
        }
      }
    } else {
      statusDiv.textContent = "No response from background. Check downloads.";
    }
    // Keep the downloadLimitContainer visible if the user wants to do another batch
    // but reset other parts. For simplicity, full reset via updateUIState('initial')
    // or we can refine this. For now, let's keep it simpler.
    // To make another download, user has to scan again.
  });
}

// --- Initialize on Load ---
document.addEventListener('DOMContentLoaded', initializePopup);
