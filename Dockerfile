# Lambda container image for the automated pipeline (watch_and_process.run_cycle,
# via lambda_handler.py). Built by AWS CodeBuild, not locally -- see
# buildspec.yml -- since this Mac's Apple Silicon CPU can't run the
# installed (Intel-only) local Docker Desktop.
FROM public.ecr.aws/lambda/python:3.11

# Pre-download the RetinaFace detector weights at build time so the
# read-only Lambda filesystem never needs to fetch them at runtime (retina-face
# would otherwise try to gdown them into $HOME/.deepface/weights on first
# use, but $HOME is not writable when the function is invoked). Only the
# detector weights are needed -- RetinaFace.detect_faces() never touches
# the much larger VGG-Face recognition weights.
ENV DEEPFACE_HOME=/opt/deepface_home
RUN mkdir -p ${DEEPFACE_HOME}/.deepface/weights && \
    curl -L -o ${DEEPFACE_HOME}/.deepface/weights/retinaface.h5 \
    https://github.com/serengil/deepface_models/releases/download/v1.0/retinaface.h5

COPY requirements-lambda.txt .
# --only-binary=:all: forces pip to only consider versions with a prebuilt
# wheel -- this base image has no compiler (no dnf/yum even, so installing
# one isn't simple either), so pip's resolver stepping back to an
# older-but-wheeled version of any package is more robust than trying to
# compile from source.
RUN pip install -r requirements-lambda.txt --target "${LAMBDA_TASK_ROOT}" --only-binary=:all:
# Installed separately with --no-deps so its declared `opencv-python`
# dependency (see requirements-lambda.txt comment) is never pulled in.
RUN pip install retina-face==0.0.17 --no-deps --target "${LAMBDA_TASK_ROOT}"

COPY crop_training_data.py train_lora.py face_fal.py supabase_io.py pipeline.py watch_and_process.py lambda_handler.py "${LAMBDA_TASK_ROOT}/"

CMD ["lambda_handler.handler"]
