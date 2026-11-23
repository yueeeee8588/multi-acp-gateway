#[cfg(windows)]
mod imp {
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject,
    };

    pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    pub struct JobObject {
        handle: HANDLE,
    }

    // Safety: Windows Job Object handles are kernel handles safe to share/send across threads.
    unsafe impl Send for JobObject {}
    unsafe impl Sync for JobObject {}

    impl JobObject {
        pub fn new() -> Result<Self, String> {
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(format!(
                    "CreateJobObjectW failed (error {})",
                    std::io::Error::last_os_error()
                ));
            }

            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

            let ok = unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    (&raw const info).cast(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if ok == 0 {
                let err = std::io::Error::last_os_error();
                unsafe { CloseHandle(handle) };
                return Err(format!("SetInformationJobObject failed: {err}"));
            }

            Ok(Self { handle })
        }

        pub fn assign_child(&self, child: &Child) -> Result<(), String> {
            let proc_handle = child.as_raw_handle() as HANDLE;
            let ok = unsafe { AssignProcessToJobObject(self.handle, proc_handle) };
            if ok == 0 {
                return Err(format!(
                    "AssignProcessToJobObject failed: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(())
        }
    }

    impl Drop for JobObject {
        fn drop(&mut self) {
            if !self.handle.is_null() {
                unsafe { CloseHandle(self.handle) };
                self.handle = std::ptr::null_mut();
            }
        }
    }

    pub fn spawn_in_job(job: &JobObject, cmd: &mut Command) -> Result<Child, String> {
        cmd.creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn process: {e}"))?;

        if let Err(err) = job.assign_child(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(err);
        }

        Ok(child)
    }
}

#[cfg(not(windows))]
mod imp {
    use std::process::{Child, Command, Stdio};

    pub struct JobObject;

    impl JobObject {
        pub fn new() -> Result<Self, String> {
            Ok(Self)
        }
    }

    pub fn spawn_in_job(_job: &JobObject, cmd: &mut Command) -> Result<Child, String> {
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn process: {e}"))
    }
}

pub use imp::{JobObject, spawn_in_job};
