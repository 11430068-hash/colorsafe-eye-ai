# ColorSafe EYE-AI

A Traditional Chinese, browser-only eye-screening prototype inspired by the supplied reference. It includes an educational landing page, guided image review, local accounts, and a screening history.

## Run

Open `index.html` in a modern browser, or serve this folder with any static-file server and open the served page. No build step or package installation is required. Browser storage APIs work most consistently from `http://localhost` or HTTPS.

## Deploy to Render

This is a static site with no build step. The root `render.yaml` configures a Render Static Site that publishes the repository root. To deploy, push this repository to GitHub, create a **Blueprint** in the Render Dashboard, and select this repository and the branch to deploy. Render will read `render.yaml` and provide an HTTPS `*.onrender.com` address. Later pushes to the connected branch deploy automatically.

The site does not use a server-side database: accounts, images, and history remain in each visitor's browser and are not shared across devices.

## Local dataset preparation

The **資料集檢查** section accepts a selected dataset folder and checks it locally in the browser. Organize images and sidecar labels under disease folders as `Disease/Images/` and `Disease/Labels/`, with matching file names (for example, `case-001.jpg` and `case-001.json`). JPEG, PNG, and standard TIFF images are inspected for dimensions and channel/color mode; mixed dimensions are compared within each `modality` when metadata is available. Missing label pairs, unsupported formats, and byte-identical images are reported. Exact duplicate checks use SHA-256 and are skipped for files larger than 64 MB or when Web Crypto is unavailable.

For patient and imaging-modality checks, add `Metadata/metadata.csv` with the columns `image_filename,patient_id,modality,label`. Set `image_filename` to a path such as `Cataract/Images/case-001.jpg` (or a filename that is unique across the dataset). Repeated patient IDs are reported so dataset splits can be made by patient; modality values are summarized to help keep microscopy and ordinary eye photographs separate. This does not verify label correctness, identify visually similar images, or diagnose disease. Selected files are not uploaded.

Use **開啟相機** to take a live photo, or **選擇照片** to upload an existing image. When using the RGBW sticker, keep its matte red, green, blue, and white squares in the same clear, glare-free frame as both eyes. The browser looks for this four-patch pattern locally and, when found, uses the white patch to estimate per-channel white-balance gains (limited to avoid extreme changes). This is a simple white-balance adjustment, not full color calibration; it depends on sticker print, lighting, camera processing, and sticker orientation. If no sticker is reliably detected, analysis continues on the original, uncorrected image and shows a warning. The unmodified original image is retained in history alongside the adjusted copy when calibration succeeds.

Live capture prefers the front-facing camera on phones, with browser fallback if the device has no front camera. MediaPipe Face Mesh runs locally to guide framing around both eyes, and capture is enabled only after both eyes are detected. The report uses the documented eye-contour landmarks (right eye 33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246; left eye 263, 249, 390, 373, 374, 380, 381, 382, 362, 466, 388, 387, 386, 385, 384, 398) and iris center/ring points 468–472 and 473–477 to locate the eye opening and iris. Camera guides are mapped to the visible video area, including any letterboxing. These landmarks locate anatomy but do not classify disease; the stye/eyelid region is not yet defined, and cataract-region measurement is not validated. If eye detection is unavailable, the report displays the full input image with a status message. The tracking library and model are downloaded from jsDelivr and Google on first use; camera frames and selected images are processed locally and are not uploaded. Live camera access requires browser permission and a secure context (`http://localhost` or HTTPS); if access is unavailable or denied, selecting a photo remains available.

Before image input, pre-screening asks whether the user had an eye injury or eye surgery within the last three months, is currently wearing contact lenses, or used eye drops within the last 30 minutes. Any unanswered item or "yes" response blocks camera and image selection. Recent injury/surgery prompts the user to stop and consult an eye-care professional; contact lenses should be removed before retrying; after eye drops, wait 30 minutes from the last use and repeat the triage. The checks are capture guidance, not medical screening or diagnosis.

The color-calibration section includes a front/back sticker diagram, placement and removal guidance, and opens the live eye-tracking camera directly. Follow the sticker manufacturer's skin-use instructions; do not place a sticker on the eyelid or eye surface.

The health notice includes a Google Maps shortcut for nearby ophthalmology care. When clicked, the browser requests the visitor's location and opens directions with that location as the origin; if location access is unavailable or denied, it opens a nearby-clinic search instead. Location is only used to construct the Maps URL and is not stored by this site.

## Local data and privacy

Accounts, password hashes, screening records, image files, and image measurements are stored in the browser's IndexedDB database named `colorsafe-eye-ai`. Data stays in that browser profile on that device; it is not uploaded or synchronized, and clearing site data removes it. This prototype does not provide server-backed authentication, account recovery, or cross-device access. Use only sample images unless you understand and accept this local-storage limitation.

Passwords are hashed in the browser with PBKDF2 before storage. This is a prototype, not a production identity or health-data system.

## Health notice

The app records whole-image color and brightness measurements and local eye-region RGB/HSV/CIELAB descriptors for the sclera-side, iris periphery, and iris-center sample areas. Measurements use the sticker-adjusted copy when the RGBW sticker is detected; otherwise they use the original image. The white patch only provides a rough white-balance reference, not a validated color calibration. Eye regions are derived from Face Mesh landmarks and are affected by lighting, exposure, makeup, and image quality. These values do not detect disease or provide a medical risk assessment; the five condition labels remain unclassified. Screening records are for demonstration and personal organization, not diagnosis. Seek professional care for eye symptoms; sudden vision loss, severe pain, injury, or marked light sensitivity warrants prompt medical attention.
