The UI aesthetics are not important, a basic web interface, realized with angular.

The backend has to be realized in nodejs.

Everything has to be deployed in docker, one image is acceptable. Two or more would be a stretch goal.

The required features are the following:
* monitoring of upload status per each file
* max 2gb file size
* multiple files batch upload
* resumability for single and batch, eg if one gets stuck, offer the option to retry/skip and continue where it left off


To achieve this local storage can be used, but there are also docker images that replicate S3 storage (to avoid deploying to actual cloud services)
I'm free to use libraries within the above frameworks (or also express framework for REST apis and use libraries to help with upload)
If libraries are available to do any part of this, using them is fine (not reinventing the wheel)


Milestone 1: basic simple single large file upload window and receiving backend with S3 storage
* offer file selection
* gracefully refuse if file larger than 2GB
* offer progress tracking in the user window
* confirm on completion with nice check mark
* stop on error
* automate test cases using test files to validate
** use 100 mb, 200mb, 1000mb, 2000mb, 2100mb test files

Milestone 2: add resume functionality
* everything in Milestone 1
* add resume option on error
* add pause/resume
* add visible cues of status (in progress, paused, error, successful)
* backend testable with automated functions
* automated dropped packets test

Milestone 3: add batch processing
* everything in Milestone 2
* extend to list of files to be uploaded
* extend file system selection mask to multi-select
* keep resume functionality per file and across the entire list, eg if one file has an issue, pause the entire list and offer to skip or retry, after which the process can continue
* have per file progress and total progress displayed on screen
* add automated tests for file list handling
* automate list handling tests by mocking the actual upload process

Milestone 4: visualize uploaded files
* everything in Milestone 3
* divide the webpage in two columns, on the left the upload selection, on the right the uploaded files
* both lists should be scrollable vertically
* add a video visualization element to the webpage, on top of the right column, to show the files that have been successfully uploaded
* add a retrieve API so uploaded files can be stramed back to the video component
* handle null case of empty upload list
* handle codecs mismatch and video file identification
* allow play and pause
* select video file by clicking on the right list
* automate test cases with short simple tiny video files in dedicated test image

stretch goal (no need to fully implement)
think about how could we use the file being uploaded while being uploaded on some cloud like storage (like s3)

deliver a presentation on what was achieved, lessons learned, issues found, etc
