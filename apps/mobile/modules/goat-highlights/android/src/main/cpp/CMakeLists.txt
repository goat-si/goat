cmake_minimum_required(VERSION 3.22.1)

project(goathighlights LANGUAGES C)

set(GOAT_HIGHLIGHTS_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../..")

add_library(
  goathighlights SHARED
  goat_highlights_jni.c
  "${GOAT_HIGHLIGHTS_ROOT}/cpp/goat_highlights.c"
  "${GOAT_HIGHLIGHTS_ROOT}/Vendor/highlights/highlights.c"
  "${GOAT_HIGHLIGHTS_ROOT}/Vendor/wasm2c/wasm-rt-impl.c"
  "${GOAT_HIGHLIGHTS_ROOT}/Vendor/wasm2c/wasm-rt-mem-impl.c"
)

target_include_directories(
  goathighlights
  PRIVATE "${GOAT_HIGHLIGHTS_ROOT}/cpp" "${GOAT_HIGHLIGHTS_ROOT}/Vendor"
          "${GOAT_HIGHLIGHTS_ROOT}/Vendor/highlights" "${GOAT_HIGHLIGHTS_ROOT}/Vendor/wasm2c"
)

# Plain malloc memory with explicit bounds checks: no guard-page signal
# handlers competing with ART's.
target_compile_definitions(
  goathighlights PRIVATE WASM_RT_USE_MMAP=0 WASM_RT_MEMCHECK_BOUNDS_CHECK=1
                       WASM_RT_SKIP_SIGNAL_RECOVERY=1
)

# The lexers are generated code; keep them fast in debug builds too.
target_compile_options(goathighlights PRIVATE -O2)

target_link_options(
  goathighlights PRIVATE "-Wl,-z,common-page-size=16384" "-Wl,-z,max-page-size=16384"
)
