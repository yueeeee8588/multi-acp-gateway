#[cfg(windows)]
mod imp {
    use crate::tray::brand::{CONSOLE_URL, MUTEX_NAME, SHOW_EVENT_NAME, STOP_EVENT_NAME};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND, GetLastError, HANDLE,
        WAIT_ABANDONED, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::System::Threading::{
        CreateEventW, CreateMutexW, EVENT_MODIFY_STATE, INFINITE, OpenEventW, OpenMutexW,
        ReleaseMutex, ResetEvent, SetEvent, WaitForSingleObject,
    };

    const SYNCHRONIZE: u32 = 0x0010_0000;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    fn to_wide_null(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn open_shell_target(target: &str) {
        let verb = to_wide_null("open");
        let file = to_wide_null(target);
        unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            );
        }
    }

    pub struct SingleInstanceGuard {
        mutex: HANDLE,
        stop_event: HANDLE,
        show_event: HANDLE,
    }

    impl SingleInstanceGuard {
        pub fn stop_event_raw(&self) -> isize {
            self.stop_event as isize
        }

        pub fn show_event_raw(&self) -> isize {
            self.show_event as isize
        }
    }

    impl Drop for SingleInstanceGuard {
        fn drop(&mut self) {
            if !self.show_event.is_null() {
                unsafe { CloseHandle(self.show_event) };
                self.show_event = std::ptr::null_mut();
            }
            if !self.stop_event.is_null() {
                unsafe { CloseHandle(self.stop_event) };
                self.stop_event = std::ptr::null_mut();
            }
            if !self.mutex.is_null() {
                unsafe {
                    ReleaseMutex(self.mutex);
                    CloseHandle(self.mutex);
                }
                self.mutex = std::ptr::null_mut();
            }
        }
    }

    fn signal_show_event() -> bool {
        let show_name = to_wide_null(SHOW_EVENT_NAME);
        let handle = unsafe { OpenEventW(EVENT_MODIFY_STATE, 0, show_name.as_ptr()) };
        if handle.is_null() {
            return false;
        }
        let ok = unsafe { SetEvent(handle) };
        unsafe { CloseHandle(handle) };
        ok != 0
    }

    pub fn acquire_or_wake(start_minimized: bool) -> Result<Option<SingleInstanceGuard>, String> {
        let mutex_name = to_wide_null(MUTEX_NAME);
        let mutex = unsafe { CreateMutexW(std::ptr::null(), 1, mutex_name.as_ptr()) };
        if mutex.is_null() {
            return Err(format!(
                "CreateMutexW failed: {}",
                std::io::Error::last_os_error()
            ));
        }

        let last_err = unsafe { GetLastError() };
        if last_err == ERROR_ALREADY_EXISTS {
            unsafe { CloseHandle(mutex) };
            if !start_minimized && !signal_show_event() {
                open_shell_target(CONSOLE_URL);
            }
            return Ok(None);
        }

        let event_name = to_wide_null(STOP_EVENT_NAME);
        let stop_event = unsafe { CreateEventW(std::ptr::null(), 1, 0, event_name.as_ptr()) };
        if stop_event.is_null() {
            let err = std::io::Error::last_os_error();
            unsafe {
                ReleaseMutex(mutex);
                CloseHandle(mutex);
            }
            return Err(format!("CreateEventW failed: {err}"));
        }
        unsafe {
            ResetEvent(stop_event);
        }

        let show_event_name = to_wide_null(SHOW_EVENT_NAME);
        let show_event = unsafe { CreateEventW(std::ptr::null(), 0, 0, show_event_name.as_ptr()) };
        if show_event.is_null() {
            let err = std::io::Error::last_os_error();
            unsafe {
                CloseHandle(stop_event);
                ReleaseMutex(mutex);
                CloseHandle(mutex);
            }
            return Err(format!("CreateEventW (show) failed: {err}"));
        }
        unsafe {
            ResetEvent(show_event);
        }

        Ok(Some(SingleInstanceGuard {
            mutex,
            stop_event,
            show_event,
        }))
    }

    pub fn request_stop_and_wait(timeout_ms: u32) -> Result<(), String> {
        let event_name = to_wide_null(STOP_EVENT_NAME);
        let stop_event = unsafe { OpenEventW(EVENT_MODIFY_STATE, 0, event_name.as_ptr()) };
        if stop_event.is_null() {
            let err = unsafe { GetLastError() };
            if err == ERROR_FILE_NOT_FOUND {
                return Ok(());
            }
            return Err(format!("OpenEventW failed (Win32 error {err})"));
        }

        let set_ok = unsafe { SetEvent(stop_event) };
        unsafe { CloseHandle(stop_event) };
        if set_ok == 0 {
            return Err(format!(
                "SetEvent failed: {}",
                std::io::Error::last_os_error()
            ));
        }

        let deadline = Instant::now() + Duration::from_millis(timeout_ms as u64);
        let mutex_name = to_wide_null(MUTEX_NAME);

        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("Timed out waiting for running gateway-tray to exit".into());
            }

            let mutex = unsafe { OpenMutexW(SYNCHRONIZE, 0, mutex_name.as_ptr()) };
            if mutex.is_null() {
                let err = unsafe { GetLastError() };
                if err == ERROR_FILE_NOT_FOUND {
                    return Ok(());
                }
                std::thread::sleep(Duration::from_millis(50));
                continue;
            }

            let wait_ms = remaining.as_millis().min(u32::MAX as u128) as u32;
            let wait_res = unsafe { WaitForSingleObject(mutex, wait_ms) };
            if wait_res == WAIT_OBJECT_0 || wait_res == WAIT_ABANDONED {
                unsafe {
                    ReleaseMutex(mutex);
                    CloseHandle(mutex);
                }
                return Ok(());
            }
            unsafe { CloseHandle(mutex) };
            if Instant::now() >= deadline {
                return Err("Timed out waiting for gateway-tray mutex release".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    pub fn spawn_stop_watcher<F>(stop_event_raw: isize, on_stop: F)
    where
        F: FnOnce() + Send + 'static,
    {
        std::thread::Builder::new()
            .name("tray-stop-watcher".into())
            .spawn(move || {
                let handle = stop_event_raw as HANDLE;
                if handle.is_null() {
                    return;
                }
                let res = unsafe { WaitForSingleObject(handle, INFINITE) };
                if res == WAIT_OBJECT_0 {
                    on_stop();
                }
            })
            .ok();
    }

    pub fn spawn_show_watcher<F>(show_event_raw: isize, mut on_show: F)
    where
        F: FnMut() + Send + 'static,
    {
        std::thread::Builder::new()
            .name("tray-show-watcher".into())
            .spawn(move || {
                let handle = show_event_raw as HANDLE;
                if handle.is_null() {
                    return;
                }
                loop {
                    let res = unsafe { WaitForSingleObject(handle, INFINITE) };
                    if res == WAIT_OBJECT_0 {
                        on_show();
                    } else {
                        break;
                    }
                }
            })
            .ok();
    }
}

#[cfg(not(windows))]
mod imp {
    pub struct SingleInstanceGuard;

    impl SingleInstanceGuard {
        pub fn stop_event_raw(&self) -> isize {
            0
        }

        pub fn show_event_raw(&self) -> isize {
            0
        }
    }

    pub fn open_shell_target(_target: &str) {}

    pub fn acquire_or_wake(_start_minimized: bool) -> Result<Option<SingleInstanceGuard>, String> {
        Ok(Some(SingleInstanceGuard))
    }

    pub fn request_stop_and_wait(_timeout_ms: u32) -> Result<(), String> {
        Ok(())
    }

    pub fn spawn_stop_watcher<F>(_stop_event_raw: isize, _on_stop: F)
    where
        F: FnOnce() + Send + 'static,
    {
    }

    pub fn spawn_show_watcher<F>(_show_event_raw: isize, _on_show: F)
    where
        F: FnMut() + Send + 'static,
    {
    }
}

pub use imp::{
    acquire_or_wake, open_shell_target, request_stop_and_wait, spawn_show_watcher,
    spawn_stop_watcher,
};
